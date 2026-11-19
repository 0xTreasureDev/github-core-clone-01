// Git smart HTTP: ref advertisement, protocol v2 ls-refs and fetch, protocol v0 fetch, and
// receive-pack pushes, all over the forge's own object model (gitobj.ts). Repositories live at
// /{owner}/{repo}.git; only the viewer's own repositories exist, everything else is a 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isAncestor,
  parseCommit,
  parseTag,
  peelTag,
  planFetch,
  readPack,
  resolveToCommit,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { branchTip, findRepo, type RepoRec } from './store.ts';
import { FORGE_AGENT, ZERO_OID, parsePktLines, pktLine, sendBytes, sidebandPackets, FLUSH_PKT, DELIM_PKT, type PktPacket } from './util.ts';

const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${FORGE_AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${FORGE_AGENT}`;

/** Sorted ref entries of a repository: full ref name to object id. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The HEAD target ref of a repository. */
function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** A v0 ref advertisement body for a service. */
function advertisementV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headRef(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) parts.push(pktLine(`${oid} ${ref}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** A protocol v2 capability advertisement body. */
function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${FORGE_AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH_PKT,
  ];
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: URLSearchParams): void {
  const repo = findRepo(owner, name);
  if (repo === null) {
    sendBytes(res, 404, Buffer.from('repository not found\n'), 'text/plain; charset=utf-8');
    return;
  }
  const service = query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBytes(res, 404, Buffer.from('unknown service\n'), 'text/plain; charset=utf-8');
    return;
  }
  const protocol = req.headers['git-protocol'];
  if (service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2')) {
    sendBytes(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
    return;
  }
  sendBytes(res, 200, advertisementV0(repo, service), `application/x-${service}-advertisement`);
}

/** The text lines of a packet list (data packets only, newline stripped). */
function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split a packet list at the first delimiter or flush: [before, after]. */
function splitPackets(packets: readonly PktPacket[]): [PktPacket[], PktPacket[]] {
  const index = packets.findIndex((packet) => packet.kind === 'delim' || packet.kind === 'flush');
  if (index < 0) return [[...packets], []];
  return [packets.slice(0, index), packets.slice(index + 1)];
}

/** The ls-refs command of protocol v2. */
function handleLsRefs(repo: RepoRec, packets: readonly PktPacket[], res: ServerResponse): void {
  const [, args] = splitPackets(packets);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of packetLines(args)) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headRef(repo);
  const headOid = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${head}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${head}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelTag(repo.objects, oid)}`;
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), FLUSH_PKT]);
  sendBytes(res, 200, body, 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const line of lines) {
    // A v0 first want line carries the negotiated capabilities after the object id.
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10) || null;
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** The fetch command of protocol v2: sectioned response with a sideband packfile. */
function handleFetchV2(repo: RepoRec, packets: readonly PktPacket[], res: ServerResponse): void {
  const [, argsPackets] = splitPackets(packets);
  const args = parseFetchArgs(packetLines(argsPackets));
  const plan = planFetch(repo.objects, args.wants, args.haves, args.shallow, args.deepen);
  const pack = writePack(plan.send.values());
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pktLine('acknowledgments\n'));
    const common = args.haves.filter((have) => resolveToCommit(repo.objects, have) !== null);
    if (common.length > 0) {
      for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM_PKT);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(FLUSH_PKT);
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** The fetch of protocol v0: shallow lines, NAK, then the sideband pack. */
function handleFetchV0(repo: RepoRec, packets: readonly PktPacket[], body: Buffer, res: ServerResponse): void {
  // v0 sends wants (with deepen) up to a flush, then haves and done up to a second flush.
  const lines = packetLines(packets);
  const args = parseFetchArgs(lines);
  void body;
  const plan = planFetch(repo.objects, args.wants, args.haves, args.shallow, args.deepen);
  const pack = writePack(plan.send.values());
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(FLUSH_PKT);
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** POST /{owner}/{repo}.git/git-upload-pack (v2 commands or a v0 fetch). */
export function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = findRepo(owner, name);
  if (repo === null) {
    sendBytes(res, 404, Buffer.from('repository not found\n'), 'text/plain; charset=utf-8');
    return;
  }
  let packets: PktPacket[];
  try {
    packets = parsePktLines(body);
  } catch {
    sendBytes(res, 400, Buffer.from('malformed pkt-line stream\n'), 'text/plain; charset=utf-8');
    return;
  }
  const protocol = req.headers['git-protocol'];
  const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (isV2) {
    const [commandPackets] = splitPackets(packets);
    const commandLine = packetLines(commandPackets)[0] ?? '';
    if (commandLine === 'command=ls-refs') {
      handleLsRefs(repo, packets, res);
      return;
    }
    if (commandLine === 'command=fetch') {
      handleFetchV2(repo, packets, res);
      return;
    }
    sendBytes(res, 400, Buffer.from('unknown command\n'), 'text/plain; charset=utf-8');
    return;
  }
  handleFetchV0(repo, packets, body, res);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  capabilities: string[];
}

/** Parse a receive-pack request: the command pkt-lines, then the raw pack bytes. */
function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  let first = true;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated command list');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line in command list');
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('command pkt-line out of bounds');
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    let capabilities: string[] = [];
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length !== 3) throw new Error('malformed ref update command');
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2], capabilities: first ? capabilities : [] });
    first = false;
  }
  return { commands, pack: body.subarray(offset) };
}

/** Judge one ref update against the store; answers null to apply it, or the refusal reason. */
function judgeUpdate(repo: RepoRec, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return 'invalid ref';
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return 'reference not found';
    return null; // a delete of an existing ref
  }
  const newObject = repo.objects.get(newOid);
  if (newObject === undefined) return 'not found';
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return 'reference already exists';
    return null; // a creation
  }
  if (current === undefined) return 'reference not found';
  if (current !== oldOid) return 'stale info';
  if (newObject.type === 'commit') {
    const oldObject = repo.objects.get(oldOid);
    if (oldObject !== undefined && oldObject.type === 'commit' && !isAncestor(repo.objects, oldOid, newOid)) {
      return 'non-fast-forward';
    }
  }
  return null;
}

/** POST /{owner}/{repo}.git/git-receive-pack: unpack, judge each ref, report status. */
export function handleReceivePack(res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = findRepo(owner, name);
  if (repo === null) {
    sendBytes(res, 404, Buffer.from('repository not found\n'), 'text/plain; charset=utf-8');
    return;
  }
  let parsed: { commands: PushCommand[]; pack: Buffer };
  try {
    parsed = parsePushBody(body);
  } catch {
    // A garbage body must not kill the server: answer a minimal report and move on.
    sendBytes(res, 200, Buffer.concat([pktLine('unpack error\n'), FLUSH_PKT]), 'application/x-git-receive-pack-result');
    return;
  }
  const capabilities = parsed.commands[0]?.capabilities ?? [];
  const sideband = capabilities.includes('side-band-64k');
  const report = (lines: string[]): void => {
    const stream = Buffer.concat(lines.map((line) => pktLine(line)));
    const parts = sideband ? [...sidebandPackets(stream, 1), FLUSH_PKT] : [stream, FLUSH_PKT];
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  };

  let unpackOk = true;
  if (parsed.pack.length > 0) {
    try {
      const read = readPack(parsed.pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object as GitObject);
      }
    } catch {
      unpackOk = false;
    }
  }
  if (!unpackOk) {
    report(['unpack error\n']);
    return;
  }
  const lines: string[] = ['unpack ok\n'];
  for (const command of parsed.commands) {
    const refusal = judgeUpdate(repo, command);
    if (refusal !== null) {
      lines.push(`ng ${command.ref} ${refusal}\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}\n`);
  }
  report(lines);
}

/** Whether a branch tip moved is irrelevant here; re-export for the REST surface. */
export { branchTip };
export type { GitObject };
export { parseCommit, parseTag };
