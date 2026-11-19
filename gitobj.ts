// The git object model, implemented from scratch on node:crypto and node:zlib: SHA-1 object
// identity, trees with git's directory sort, commits, annotated tags, packfile reading (with
// OFS/REF delta resolution) and packfile writing (plain, undeltified entries), plus the graph
// walks the smart-HTTP server and the merge logic need (ancestry, merge base, fetch closure).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** A repository's object store: object id to object. */
export type ObjectStore = Map<string, GitObject>;

const TYPE_CODES: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of a buffer, as lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of an object: SHA-1 over `<type> <length>\0` + data. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Insert an object into a store and answer its id (idempotent). */
export function storeObject(store: ObjectStore, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  /** ASCII mode as git stores it: '100644', '100755', '120000', or '40000' for a subtree. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: entries compare by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries with git's sort applied. */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into a map of file path to blob entry. */
export function flattenTree(store: ObjectStore, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

/**
 * Build (and store) the tree hierarchy for a flat path-to-blob map; answers the root tree id.
 * An empty map yields the canonical empty tree.
 */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = dir.dirs.get(segments[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segments[i], next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1], entry);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return storeObject(store, 'tree', buildTreeData(entries));
  };
  return emit(root);
}

// --------------------------------------------------------------------------- commits and tags

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes (headers, then a blank line, then the message verbatim). */
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  // Header continuation lines (e.g. gpgsig) start with a space; fold them away before splitting.
  const lines = headerText.replace(/\n /g, ' ').split('\n');
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit exactly as git would. */
export function buildCommitData(commit: CommitData): Buffer {
  let text = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) text += `parent ${parent}\n`;
  text += `author ${commit.author}\ncommitter ${commit.committer}\n\n${commit.message}`;
  return Buffer.from(text, 'utf8');
}

/** Parse an annotated tag object's target. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Peel an object id through annotated tags to the commit it names, or null. */
export function resolveToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Peel an object id through annotated tags to whatever non-tag object it names. */
export function peelTag(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The tree id of a commit. */
export function commitTreeOid(store: ObjectStore, commitOid: string): string | null {
  const object = store.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The flattened file map of a commit (empty for an unknown commit). */
export function commitFiles(store: ObjectStore, commitOid: string): Map<string, { oid: string; mode: string }> {
  const tree = commitTreeOid(store, commitOid);
  return flattenTree(store, tree);
}

// --------------------------------------------------------------------------- graph walks

/** Every commit reachable from `tip`, with its shortest distance (tip = 0). */
export function ancestorDistances(store: ObjectStore, tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  const start = resolveToCommit(store, tip);
  if (start === null) return distances;
  const queue: Array<[string, number]> = [[start, 0]];
  while (queue.length > 0) {
    const [oid, distance] = queue.shift()!;
    if (distances.has(oid)) continue;
    distances.set(oid, distance);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, distance + 1]);
  }
  return distances;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return ancestorDistances(store, descendant).has(ancestor);
}

/** The best common ancestor of two commits (least total distance), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = ancestorDistances(store, a);
  const fromB = ancestorDistances(store, b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, distanceA] of fromA) {
    const distanceB = fromB.get(oid);
    if (distanceB === undefined) continue;
    const score = distanceA + distanceB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** All ancestors of a commit (including itself), newest first by distance then discovery. */
export function listAncestors(store: ObjectStore, tip: string): string[] {
  const distances = ancestorDistances(store, tip);
  return [...distances.entries()].sort((x, y) => x[1] - y[1]).map(([oid]) => oid);
}

// --------------------------------------------------------------------------- packfiles

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Adler-32 of a buffer, as zlib's trailer carries it (implemented directly; Node hides its own). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Find the exact byte length of the zlib stream starting at `start`, given its inflated bytes:
 * a zlib stream ends with the adler32 of its content, so scan for that trailer and verify the
 * candidate prefix inflates to exactly the expected bytes. Two inflations per entry, not a
 * binary search's dozen.
 */
function zlibStreamLength(buffer: Buffer, start: number, expected: Buffer): number {
  const adler = adler32(expected);
  const b0 = (adler >>> 24) & 0xff;
  const b1 = (adler >>> 16) & 0xff;
  const b2 = (adler >>> 8) & 0xff;
  const b3 = adler & 0xff;
  for (let end = start + 6; end <= buffer.length; end += 1) {
    if (buffer[end - 4] === b0 && buffer[end - 3] === b1 && buffer[end - 2] === b2 && buffer[end - 1] === b3) {
      try {
        if (inflateSync(buffer.subarray(start, end)).equals(expected)) return end - start;
      } catch {
        // A coincidental trailer inside the compressed data; keep scanning.
      }
    }
  }
  throw new Error('zlib stream end not found');
}

export interface PackReadResult {
  /** Every object the pack defines (delta bases that live outside the pack are not repeated). */
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Read a packfile. `externalBase` resolves REF_DELTA bases the pack does not carry (a thin pack
 * against the repository's own store). Throws on any structural problem.
 */
export function readPack(pack: Buffer, externalBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has a bad signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    type: ObjectType;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
    offset: number;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset encoded as a base-128 varint with the +1 continuation rule.
      let byte2 = pack[offset];
      offset += 1;
      let back = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte2 & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const data = inflateSync(pack.subarray(offset));
    if (data.length !== size) throw new Error('pack entry size mismatch');
    offset += zlibStreamLength(pack, offset, data);
    const type = CODE_TYPES[typeCode];
    if (typeCode !== 6 && typeCode !== 7 && type === undefined) throw new Error(`unknown pack entry type ${typeCode}`);
    const entry: RawEntry = { type: type ?? 'blob', data, baseOid, baseOffset, offset: entryOffset };
    // For delta entries, `data` is the delta payload; the real type comes from the base.
    (entry as { delta?: Buffer }).delta = typeCode === 6 || typeCode === 7 ? data : undefined;
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<string, GitObject>();
  const resolveEntry = (entry: RawEntry, seen: Set<number>): GitObject => {
    const delta = (entry as { delta?: Buffer }).delta;
    if (delta === undefined) return { type: entry.type, data: entry.data };
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let base: GitObject | undefined;
    if (entry.baseOffset !== undefined) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('OFS_DELTA base not in pack');
      base = resolveEntry(baseEntry, seen);
    } else if (entry.baseOid !== undefined) {
      base = resolved.get(entry.baseOid) ?? externalBase?.(entry.baseOid);
      if (base === undefined) {
        // The base may be a plain entry later in the pack: find it by scanning raw entries.
        for (const candidate of entries) {
          if ((candidate as { delta?: Buffer }).delta === undefined && hashObject(candidate.type, candidate.data) === entry.baseOid) {
            base = { type: candidate.type, data: candidate.data };
            break;
          }
        }
      }
      if (base === undefined) throw new Error('REF_DELTA base not found');
    }
    if (base === undefined) throw new Error('delta without a base');
    return { type: base.type, data: applyDelta(base.data, delta) };
  };
  for (const entry of entries) {
    const object = resolveEntry(entry, new Set());
    resolved.set(hashObject(object.type, object.data), object);
  }
  return { objects: resolved, count };
}

/** Write a packfile of plain (undeltified) entries: header, zlib streams, SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    const typeCode = TYPE_CODES[object.type];
    let size = object.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size === 0) {
      headBytes.push(first);
    } else {
      headBytes.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        headBytes.push(byte);
      }
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// --------------------------------------------------------------------------- fetch closure

export interface FetchPlan {
  /** The objects to pack and send. */
  send: Map<string, GitObject>;
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Client shallow commits whose parents are now included. */
  unshallow: string[];
}

/** All objects reachable from `tips`; commit traversal does not descend past `stopAt` commits. */
function reachableObjects(store: ObjectStore, tips: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!stopAt.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

/**
 * Compute what a fetch must send: everything reachable from `wants` that the client cannot
 * already reach from `haves`, honouring the client's shallow boundary (`clientShallow`: commits
 * the client holds without their parents) and an optional `deepen` depth measured from the wants.
 */
export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  deepen: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const exclude = reachableObjects(store, haves, shallowSet);
  const send = new Map<string, GitObject>();
  const addWithTreeClosure = (rootOid: string): void => {
    const stack = [rootOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (send.has(oid) || exclude.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      send.set(oid, object);
      if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
      else if (object.type === 'tag') stack.push(parseTag(object.data).object);
    }
  };

  // Breadth-first over commits, wants at distance 1.
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!exclude.has(want)) send.set(want, object);
      const target = resolveToCommit(store, want);
      if (target !== null) queue.push([target, 1]);
    } else if (object.type === 'commit') {
      queue.push([want, 1]);
    } else {
      addWithTreeClosure(want);
    }
  }
  const visited = new Map<string, number>();
  const sentCommits = new Set<string>();
  while (queue.length > 0) {
    const [oid, distance] = queue.shift()!;
    if (visited.has(oid) && visited.get(oid)! <= distance) continue;
    visited.set(oid, distance);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (exclude.has(oid)) {
      // The client holds this commit. Only a shallow-boundary commit is descended through:
      // its parents are exactly what a deepen asks for.
      if (shallowSet.has(oid) && (deepen === null || distance < deepen)) {
        for (const parent of commit.parents) queue.push([parent, distance + 1]);
      }
      continue;
    }
    if (deepen !== null && distance > deepen) continue;
    send.set(oid, object);
    sentCommits.add(oid);
    addWithTreeClosure(commit.tree);
    if (deepen === null || distance < deepen) {
      for (const parent of commit.parents) queue.push([parent, distance + 1]);
    }
  }

  const shallow: string[] = [];
  for (const oid of sentCommits) {
    const object = store.get(oid);
    if (object === undefined) continue;
    const commit = parseCommit(object.data);
    if (commit.parents.some((parent) => !send.has(parent) && !exclude.has(parent) && store.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.length > 0 && commit.parents.some((parent) => send.has(parent))) unshallow.push(oid);
  }
  return { send, shallow, unshallow };
}
