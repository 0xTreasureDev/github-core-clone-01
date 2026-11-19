// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP. The server speaks the
// modern 2026-07-28 revision (server/discover, no handshake, no session) and the legacy
// initialize handshake for older clients. Its six tools act on the same store as REST and
// GraphQL, so an object created over MCP reads back over /api/v3 unchanged.

import type { ServerResponse } from 'node:http';
import {
  createIssue,
  createPull,
  createRepo,
  findRepo,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
  type RepoRec,
} from './store.ts';
import { FORGE_VERSION, VIEWER, sendJson } from './util.ts';

const SERVER_INFO = { name: 'github-core-clone', version: FORGE_VERSION };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/** The tool list: fixed at module scope so two tools/list calls answer byte-for-byte identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

type Json = Record<string, unknown>;

function toolSuccess(value: unknown): Json {
  const text = JSON.stringify(value);
  const result: Json = { content: [{ type: 'text', text }], isError: false };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

function toolError(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoArg(args: Json): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repo === '') return null;
  return findRepo(owner, repo);
}

/** Run one tool; missing required arguments and unknown objects are tool errors (isError). */
function callTool(name: string, args: Json): Json | null {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return null;
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repo = createRepo({
        name: String(args.name),
        description: typeof args.description === 'string' ? args.description : undefined,
        isPrivate: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if (repo === null) return toolError(`repository ${String(args.name)} already exists`);
      return toolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (repo === null) return toolError('repository not found');
      return toolSuccess(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (repo === null) return toolError('repository not found');
      try {
        const issue = createIssue(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolSuccess(issueJson(repo, issue));
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolSuccess(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return toolError('repository not found');
      const pull = createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if (pull === null) return toolError('head or base branch does not exist');
      return toolSuccess(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError('pull request not found');
      if (!pull.merged) {
        const sha = mergePull(repo, pull);
        if (sha === null) return toolError('pull request is not mergeable');
      }
      return toolSuccess(pullJson(repo, pull));
    }
    default:
      return null;
  }
}

/** Dispatch one JSON-RPC request object; answers the response object, or null for a notification. */
function dispatch(request: Json): Json | null {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Json;
  const isNotification = request.id === undefined;
  const result = (value: unknown): Json => ({ jsonrpc: '2.0', id, result: value });
  const error = (code: number, message: string): Json => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover':
      return result({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result(toolsListResult());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Json;
      const outcome = callTool(name, args);
      if (outcome === null) return error(-32602, `unknown tool: ${name}`);
      return result(outcome);
    }
    default:
      if (isNotification) return null;
      return error(-32601, `method not found: ${method}`);
  }
}

/** POST /mcp (authentication is the app router's job, before this runs). */
export function handleMcp(res: ServerResponse, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? dispatch(entry as Json) : null))
      .filter((entry) => entry !== null);
    sendJson(res, 200, responses);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  const response = dispatch(parsed as Json);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': 'forge-notification' });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

/** The viewer login, for the app router's convenience. */
export const MCP_VIEWER_LOGIN = VIEWER.login;
