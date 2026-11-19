// GitHub REST v3 under /api/v3: repositories, branches, commits, contents, git refs, labels,
// issues, comments and pull requests. Every reply is JSON with a request id; errors are
// {message} objects; repositories exist only under the token owner's login (any other owner
// is a 404, never a 403).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { commitFiles, hashObject, listAncestors, parseCommit, parseTree } from './gitobj.ts';
import {
  addComment,
  branchTip,
  commentJson,
  commitFilesChange,
  countLines,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteRepo,
  findRepo,
  issueJson,
  labelJson,
  listRepos,
  mergePull,
  pullFiles,
  pullJson,
  repoJson,
  resolveRef,
  userJson,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { FORGE_VERSION, VIEWER, nowIso, sendJson } from './util.ts';

type Json = Record<string, unknown>;

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

/** Parse a JSON request body; answers false (after sending a 400) when it is malformed. */
function parseBody(res: ServerResponse, body: Buffer): Json | null {
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Json;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
}

/** Slice a list by per_page/page and build the Link header for the next page, when one exists. */
function paginate<T>(req: IncomingMessage, path: string, query: URLSearchParams, items: readonly T[]): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URLSearchParams(query);
    next.set('per_page', String(perPage));
    next.set('page', String(page + 1));
    link = `<http://${host}${path}?${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

/** The ident line of a commit as REST author/committer fields. */
function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: '', email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

/** The REST commit object. */
function commitJson(repo: RepoRec, sha: string): Json {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return { sha };
  const commit = parseCommit(object.data);
  return {
    sha,
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

/** Walk a commit's tree to one path; answers the entry kind and id, or null. */
function treeEntryAt(repo: RepoRec, commitSha: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  const commitObject = repo.objects.get(commitSha);
  if (commitObject === undefined || commitObject.type !== 'commit') return null;
  let treeOid = parseCommit(commitObject.data).tree;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return { kind: 'dir', oid: treeOid, mode: '40000' };
  for (let i = 0; i < segments.length; i += 1) {
    const treeObject = repo.objects.get(treeOid);
    if (treeObject === undefined || treeObject.type !== 'tree') return null;
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

// --------------------------------------------------------------------------- repositories

function handleCreateRepo(res: ServerResponse, body: Buffer): void {
  const input = parseBody(res, body);
  if (input === null) return;
  const name = typeof input.name === 'string' ? input.name : '';
  if (name === '') {
    unprocessable(res, 'Validation Failed: name is required');
    return;
  }
  const repo = createRepo({
    name,
    description: typeof input.description === 'string' ? input.description : undefined,
    isPrivate: typeof input.private === 'boolean' ? input.private : undefined,
    autoInit: input.auto_init === true,
  });
  if (repo === null) {
    unprocessable(res, 'Repository creation failed: name already exists on this account');
    return;
  }
  sendJson(res, 201, repoJson(repo));
}

function handleRepo(res: ServerResponse, req: IncomingMessage, method: string, repo: RepoRec, body: Buffer): void {
  if (method === 'GET') {
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (method === 'PATCH') {
    const input = parseBody(res, body);
    if (input === null) return;
    if (typeof input.description === 'string') repo.description = input.description;
    if (typeof input.private === 'boolean') repo.isPrivate = input.private;
    if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
    if (typeof input.name === 'string' && input.name !== '') repo.name = input.name;
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (method === 'DELETE') {
    deleteRepo(repo.owner, repo.name);
    res.writeHead(204, { 'x-github-request-id': 'forge-delete' });
    res.end();
    return;
  }
  notFound(res);
}

// --------------------------------------------------------------------------- branches, commits, refs

function handleBranches(res: ServerResponse, repo: RepoRec, rest: string[]): void {
  if (rest.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
    return;
  }
  const branch = rest.join('/');
  const tip = branchTip(repo, branch);
  if (tip === null) {
    notFound(res);
    return;
  }
  sendJson(res, 200, {
    name: branch,
    commit: { sha: tip, ...commitJson(repo, tip).commit as Json, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${tip}` },
    protected: false,
  });
}

function handleCommits(res: ServerResponse, repo: RepoRec, rest: string[], query: URLSearchParams): void {
  if (rest.length === 1) {
    const sha = rest[0];
    if (repo.objects.get(sha)?.type !== 'commit') {
      notFound(res);
      return;
    }
    sendJson(res, 200, commitJson(repo, sha));
    return;
  }
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    sendJson(res, 200, []);
    return;
  }
  const commits = listAncestors(repo.objects, tip).map((sha) => commitJson(repo, sha));
  sendJson(res, 200, commits);
}

function handleGitRefs(res: ServerResponse, repo: RepoRec, method: string, rest: string[], body: Buffer): void {
  if (method === 'POST' && rest.length === 0) {
    const input = parseBody(res, body);
    if (input === null) return;
    const ref = typeof input.ref === 'string' ? input.ref : '';
    const sha = typeof input.sha === 'string' ? input.sha : '';
    const object = repo.objects.get(sha);
    if (!ref.startsWith('refs/') || object === undefined) {
      unprocessable(res, 'Validation Failed: ref or sha is invalid');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: object.type } });
    return;
  }
  if (method === 'GET') {
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      notFound(res);
      return;
    }
    const object = repo.objects.get(sha);
    sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
    return;
  }
  notFound(res);
}

// --------------------------------------------------------------------------- contents

function handleContents(res: ServerResponse, req: IncomingMessage, method: string, repo: RepoRec, rest: string[], query: URLSearchParams, body: Buffer): void {
  const path = rest.join('/');
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const commitSha = resolveRef(repo, ref);
    if (commitSha === null) {
      notFound(res);
      return;
    }
    const entry = treeEntryAt(repo, commitSha, path);
    if (entry === null) {
      notFound(res);
      return;
    }
    if (entry.kind === 'file') {
      const blob = repo.objects.get(entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: entry.oid,
        download_url: null,
      });
      return;
    }
    // A directory: its immediate children from the tree itself.
    const treeObject = repo.objects.get(entry.oid);
    if (treeObject === undefined || treeObject.type !== 'tree') {
      notFound(res);
      return;
    }
    const children = parseTree(treeObject.data).map((child) => {
      const childPath = path === '' ? child.name : `${path}/${child.name}`;
      const isDir = child.mode === '40000';
      const blob = isDir ? undefined : repo.objects.get(child.oid);
      return {
        type: isDir ? 'dir' : 'file',
        name: child.name,
        path: childPath,
        sha: child.oid,
        size: isDir ? 0 : (blob?.data.length ?? 0),
        download_url: null,
      };
    });
    sendJson(res, 200, children);
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const input = parseBody(res, body);
    if (input === null) return;
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const message = typeof input.message === 'string' ? input.message : '';
    if (message === '') {
      unprocessable(res, 'Validation Failed: message is required');
      return;
    }
    // The files the commit would build on: the branch's own, or the default branch's when the
    // branch is about to be created by this write.
    const baseTip = branchTip(repo, branch) ?? (branch !== repo.defaultBranch ? branchTip(repo, repo.defaultBranch) : null);
    const currentFiles = baseTip === null ? new Map<string, { oid: string; mode: string }>() : commitFiles(repo.objects, baseTip);
    const existing = currentFiles.get(path);

    if (method === 'DELETE') {
      if (existing === undefined) {
        notFound(res);
        return;
      }
      if (typeof input.sha === 'string' && input.sha !== existing.oid) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
      const result = commitFilesChange(repo, branch, new Map([[path, { content: null }]]), message);
      sendJson(res, 200, { content: null, commit: { sha: result.commitSha, message } });
      return;
    }

    // PUT: create or update one file.
    const contentText = typeof input.content === 'string' ? input.content.replace(/\s+/g, '') : '';
    const content = Buffer.from(contentText, 'base64');
    if (existing !== undefined && typeof input.sha === 'string' && input.sha !== existing.oid) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    const blobOid = hashObject('blob', content);
    const result = commitFilesChange(repo, branch, new Map([[path, { content }]]), message);
    const created = existing === undefined;
    sendJson(res, created ? 201 : 200, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        download_url: null,
      },
      commit: { sha: result.commitSha, message },
    });
    return;
  }
  notFound(res);
}

// --------------------------------------------------------------------------- labels

function handleLabels(res: ServerResponse, repo: RepoRec, method: string, body: Buffer): void {
  if (method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()].map(labelJson));
    return;
  }
  if (method === 'POST') {
    const input = parseBody(res, body);
    if (input === null) return;
    const name = typeof input.name === 'string' ? input.name : '';
    if (name === '') {
      unprocessable(res, 'Validation Failed: name is required');
      return;
    }
    if (repo.labels.has(name)) {
      unprocessable(res, 'Validation Failed: name already exists');
      return;
    }
    const label = createLabel(repo, name, typeof input.color === 'string' ? input.color : undefined, typeof input.description === 'string' ? input.description : undefined);
    sendJson(res, 201, labelJson(label));
    return;
  }
  notFound(res);
}

// --------------------------------------------------------------------------- issues

function issueOrPullAsIssue(res: ServerResponse, repo: RepoRec, number: number): void {
  const issue = repo.issues.get(number);
  if (issue !== undefined) {
    sendJson(res, 200, issueJson(repo, issue));
    return;
  }
  const pull = repo.pulls.get(number);
  if (pull !== undefined) {
    sendJson(res, 200, {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      labels: [],
      user: userJson(),
      comments: 0,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.closedAt,
      pull_request: { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` },
    });
    return;
  }
  notFound(res);
}

function handleIssues(res: ServerResponse, req: IncomingMessage, repo: RepoRec, method: string, rest: string[], query: URLSearchParams, body: Buffer): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const input = parseBody(res, body);
      if (input === null) return;
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') {
        unprocessable(res, 'Validation Failed: title is required');
        return;
      }
      const labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === 'string') : [];
      try {
        const issue = createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '', labels });
        sendJson(res, 201, issueJson(repo, issue));
      } catch (error) {
        if ((error as { code?: string }).code === 'UNKNOWN_LABEL') {
          unprocessable(res, (error as Error).message);
          return;
        }
        throw error;
      }
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, link } = paginate(req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, issues);
      sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(number)) {
    notFound(res);
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    const issue = repo.issues.get(number);
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentJson));
      return;
    }
    if (method === 'POST') {
      const input = parseBody(res, body);
      if (input === null) return;
      const text = typeof input.body === 'string' ? input.body : '';
      if (text === '') {
        unprocessable(res, 'Validation Failed: body is required');
        return;
      }
      const comment = addComment(issue, text);
      sendJson(res, 201, commentJson(comment));
      return;
    }
    notFound(res);
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      issueOrPullAsIssue(res, repo, number);
      return;
    }
    if (method === 'PATCH') {
      const issue = repo.issues.get(number);
      if (issue === undefined) {
        notFound(res);
        return;
      }
      const input = parseBody(res, body);
      if (input === null) return;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'closed' || input.state === 'open') {
        issue.state = input.state;
        issue.closedAt = input.state === 'closed' ? nowIso() : null;
      }
      if (Array.isArray(input.labels)) {
        const labels = input.labels.filter((label): label is string => typeof label === 'string');
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            unprocessable(res, `label "${name}" does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
  }
  notFound(res);
}

// --------------------------------------------------------------------------- pull requests

function handlePulls(res: ServerResponse, req: IncomingMessage, repo: RepoRec, method: string, rest: string[], query: URLSearchParams, body: Buffer): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const input = parseBody(res, body);
      if (input === null) return;
      const title = typeof input.title === 'string' ? input.title : '';
      const headRaw = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : '';
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      if (title === '' || head === '' || base === '') {
        unprocessable(res, 'Validation Failed: title, head and base are required');
        return;
      }
      if (head === base) {
        unprocessable(res, 'Validation Failed: head and base must differ');
        return;
      }
      const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) {
        unprocessable(res, `A pull request already exists for ${repo.owner}:${head} -> ${base}`);
        return;
      }
      const pull = createPull(repo, { title, body: typeof input.body === 'string' ? input.body : '', head, base });
      if (pull === null) {
        unprocessable(res, 'Validation Failed: head or base branch does not exist');
        return;
      }
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, pulls);
      sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), link === null ? {} : { link });
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(number)) {
    notFound(res);
    return;
  }
  const pull: PullRec | undefined = repo.pulls.get(number);

  if (rest.length === 1 && method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    const files = pullFiles(repo, pull).map((file) => {
      const oldData = file.oldOid === null ? Buffer.alloc(0) : (repo.objects.get(file.oldOid)?.data ?? Buffer.alloc(0));
      const newData = file.newOid === null ? Buffer.alloc(0) : (repo.objects.get(file.newOid)?.data ?? Buffer.alloc(0));
      const additions = file.newOid === null ? 0 : countLines(newData);
      const deletions = file.oldOid === null ? 0 : countLines(oldData);
      return {
        sha: file.newOid ?? file.oldOid ?? '',
        filename: file.path,
        status: file.status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.newOid ?? ''}`,
        raw_url: '',
        contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.path}`,
      };
    });
    sendJson(res, 200, files);
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    const input = parseBody(res, body);
    if (input === null) return;
    if (pull.merged || pull.state === 'closed') {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    const sha = mergePull(repo, pull);
    if (sha === null) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  notFound(res);
}

// --------------------------------------------------------------------------- the router

/** Handle one authenticated /api/v3 request. `segments` are the decoded path parts after /api/v3. */
export function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Buffer): void {
  const method = req.method ?? 'GET';

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false });
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] === 'rate_limit' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { rate: { limit: 5000, remaining: 5000, reset: 1893456000 }, resources: {} });
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, userJson());
      return;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') {
        handleCreateRepo(res, body);
        return;
      }
      if (method === 'GET') {
        const { page, link } = paginate(req, '/api/v3/user/repos', query, listRepos());
        sendJson(res, 200, page.map(repoJson), link === null ? {} : { link });
        return;
      }
    }
    notFound(res);
    return;
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const repo = findRepo(owner, name);
    if (repo === null) {
      notFound(res);
      return;
    }
    const rest = segments.slice(3);
    if (rest.length === 0) {
      handleRepo(res, req, method, repo, body);
      return;
    }
    switch (rest[0]) {
      case 'branches':
        if (method === 'GET') {
          handleBranches(res, repo, rest.slice(1));
          return;
        }
        break;
      case 'commits':
        if (method === 'GET') {
          handleCommits(res, repo, rest.slice(1), query);
          return;
        }
        break;
      case 'contents':
        handleContents(res, req, method, repo, rest.slice(1), query, body);
        return;
      case 'git':
        if (rest[1] === 'refs') {
          handleGitRefs(res, repo, method, rest.slice(2), body);
          return;
        }
        break;
      case 'labels':
        if (rest.length === 1) {
          handleLabels(res, repo, method, body);
          return;
        }
        break;
      case 'issues':
        handleIssues(res, req, repo, method, rest.slice(1), query, body);
        return;
      case 'pulls':
        handlePulls(res, req, repo, method, rest.slice(1), query, body);
        return;
      default:
        break;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

/** The viewer constant, re-exported for the app router's user route. */
export { VIEWER };
export type { IssueRec, PullRec };
