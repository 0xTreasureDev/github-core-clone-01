// Shared helpers: the deterministic clock, global ids, HTTP plumbing and pkt-line framing.
//
// The forge is graded on repeatability: every timestamp it emits derives from one deterministic
// clock (MAKEFUN_TRIAL_NOW when the env provides it, else a fixed base at the scenario epoch),
// advanced by a monotonic tick, so live and replayed runs answer byte-identical data.

/** The single authenticated user of this forge: the scenario viewer the trial token belongs to. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The forge's own version string, reported by GET /api/v3/meta and the MCP server identity. */
export const FORGE_VERSION = '1.0.0';
/** The agent string advertised in git protocol exchanges. */
export const FORGE_AGENT = 'github-core-clone/1.0.0';

/** The all-zero object id git uses for unborn refs and deletions. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Whether a string is a 40-character lowercase hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// --------------------------------------------------------------------------- clock

function clockBaseSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch
}

const CLOCK_BASE = clockBaseSec();
let clockTick = 0;

/** The next deterministic timestamp, in epoch seconds (strictly increasing per call). */
export function nowSec(): number {
  const value = CLOCK_BASE + clockTick;
  clockTick += 1;
  return value;
}

/** The next deterministic timestamp as an ISO-8601 string. */
export function nowIso(): string {
  return new Date(nowSec() * 1000).toISOString();
}

/** A git author/committer line for the viewer at `ts` epoch seconds. */
export function viewerIdent(ts: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
}

// --------------------------------------------------------------------------- global ids

/** An opaque Relay-style global id: base64 of `Kind:part:part...`. Never the plain database id. */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id back to its kind and parts, or null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- HTTP plumbing

import type { IncomingMessage, ServerResponse } from 'node:http';

let requestCounter = 0;

/** A fresh non-empty X-GitHub-Request-Id value. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

/** Read a whole request body as one Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answer with a JSON body and the forge's standard API headers. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes under an explicit content type (git smart HTTP). */
export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Decode one URL path segment (never throws). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// --------------------------------------------------------------------------- pkt-line framing

/** One pkt-line: a 4-hex-digit length prefix (counting itself) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet that ends a pkt-line stream. */
export const FLUSH_PKT = Buffer.from('0000', 'ascii');
/** The delimiter packet that separates protocol v2 sections. */
export const DELIM_PKT = Buffer.from('0001', 'ascii');

/** One parsed packet of a pkt-line stream. */
export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Parse a complete pkt-line buffer. Throws on a malformed length prefix, which is exactly the
 * signal the receive-pack handler needs to refuse a garbage body without dying.
 */
export function parsePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of bounds');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Frame `data` as side-band packets: band byte + chunk, each pkt-line within the 65520 cap. */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515; // 1 band byte + 65515 payload + 4 header = 65520, the pkt-line maximum
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}
