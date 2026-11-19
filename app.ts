// The forge's HTTP server: routing and the token gate. Surfaces: /healthz (the env's boot
// probe, unauthenticated), /api/v3 (REST), /api/graphql (GraphQL v4), /mcp (MCP over
// Streamable HTTP) and /{owner}/{repo}.git (git smart HTTP). Every other route is GitHub's
// JSON 404. Authentication is one bearer token from MAKEFUN_SHOP_TOKEN: without it, or with a
// wrong one, every surface but /healthz answers 401 with a JSON {message} body.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitserver.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { decodeSegment, readBody, sendJson } from './util.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether the request carries the trial token (an unset token means a local dev run). */
function authenticated(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${TOKEN}` || header === `token ${TOKEN}`;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;

  // The env's boot probe: no token, called twice, must answer 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authenticated(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  if (path === '/mcp') {
    if (method === 'POST') {
      handleMcp(res, body);
      return;
    }
    if (method === 'DELETE') {
      // A legacy session goodbye; this server keeps no sessions.
      res.writeHead(200, { 'x-github-request-id': 'forge-session-close' });
      res.end();
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/api/graphql') {
    if (method === 'POST') {
      handleGraphQL(res, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const rest = path.slice('/api/v3'.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeSegment);
    handleRest(req, res, segments, url.searchParams, body);
    return;
  }

  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]);
    const name = decodeSegment(gitMatch[2]);
    const leaf = gitMatch[3];
    if (leaf === 'info/refs' && method === 'GET') {
      handleInfoRefs(req, res, owner, name, url.searchParams);
      return;
    }
    if (leaf === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, owner, name, body);
      return;
    }
    if (leaf === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(res, owner, name, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens (main.ts binds an ephemeral port). */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      // A handler failure must answer, never hang or crash: the suite's next call is the judge.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing left to answer on.
      }
    });
  });
}
