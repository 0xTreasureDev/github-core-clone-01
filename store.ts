// The forge's state and domain operations: repositories (with their git object stores and refs),
// labels, issues, comments and pull requests, plus the contents-commit and squash-merge machinery
// every surface (REST, GraphQL, MCP, git push) shares. Everything is in memory; ids and the
// issue/pull numbering follow GitHub (one shared counter per repository).

import {
  buildCommitData,
  buildTreeFromFiles,
  commitFiles,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  storeObject,
  type GitObject,
  type ObjectStore,
} from './gitobj.ts';
import { VIEWER, globalId, nowIso, nowSec, viewerIdent } from './util.ts';

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

interface ForgeState {
  repos: Map<string, RepoRec>;
  nextRepoId: number;
  nextIssueId: number;
  nextCommentId: number;
  nextLabelId: number;
}

const forge: ForgeState = {
  repos: new Map(),
  nextRepoId: 1,
  nextIssueId: 1,
  nextCommentId: 1,
  nextLabelId: 1,
};

/** The repository key: the forge has one owner, the token's login. */
export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Find a repository the token may see: only the viewer's own repositories exist for it. */
export function findRepo(owner: string, name: string): RepoRec | null {
  if (owner !== VIEWER.login) return null;
  return forge.repos.get(repoKey(owner, name)) ?? null;
}

/** Find a repository by its numeric database id. */
export function findRepoById(id: number): RepoRec | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

/** All of the viewer's repositories, in creation order. */
export function listRepos(): RepoRec[] {
  return [...forge.repos.values()].sort((a, b) => a.id - b.id);
}

export interface CreateRepoInput {
  name: string;
  description?: string;
  isPrivate?: boolean;
  autoInit?: boolean;
}

/** Create a repository; answers null when the name is already taken (the caller maps that to 422). */
export function createRepo(input: CreateRepoInput): RepoRec | null {
  const key = repoKey(VIEWER.login, input.name);
  if (forge.repos.has(key)) return null;
  const ts = nowIso();
  const repo: RepoRec = {
    id: forge.nextRepoId,
    owner: VIEWER.login,
    name: input.name,
    isPrivate: input.isPrivate ?? false,
    description: input.description ?? '',
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  forge.nextRepoId += 1;
  forge.repos.set(key, repo);
  if (input.autoInit) {
    commitFilesChange(repo, repo.defaultBranch, new Map([['README.md', { content: Buffer.from(`# ${input.name}\n`), mode: '100644' }]]), `Initial commit`);
  }
  return repo;
}

/** Delete a repository outright (204 semantics); answers whether it existed. */
export function deleteRepo(owner: string, name: string): boolean {
  if (owner !== VIEWER.login) return false;
  return forge.repos.delete(repoKey(owner, name));
}

// --------------------------------------------------------------------------- refs and commits

/** The commit a branch points at, or null when the branch is unborn or missing. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The flattened files of a branch tip (empty map for an unborn branch). */
export function branchFiles(repo: RepoRec, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = branchTip(repo, branch);
  if (tip === null) return new Map();
  return commitFiles(repo.objects, tip);
}

/** Resolve a ref-ish (branch name, full ref, or commit id) to a commit id. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') return branchTip(repo, repo.defaultBranch);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return byRef;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  if (object !== undefined && object.type === 'tag') {
    let current = ref;
    for (let hops = 0; hops < 8; hops += 1) {
      const tagObject = repo.objects.get(current);
      if (tagObject === undefined || tagObject.type !== 'tag') break;
      const match = /^object ([0-9a-f]{40})$/m.exec(tagObject.data.toString('utf8'));
      if (match === null) break;
      current = match[1];
      const target = repo.objects.get(current);
      if (target !== undefined && target.type === 'commit') return current;
    }
  }
  return null;
}

export interface FileChange {
  content: Buffer | null; // null deletes the path
  mode?: string;
}

/**
 * Commit a set of file changes on a branch (creating the branch from the default branch's tip
 * when it does not exist yet, or as a root commit on an unborn repository). Answers the new
 * commit id and the resulting file map.
 */
export function commitFilesChange(
  repo: RepoRec,
  branch: string,
  changes: ReadonlyMap<string, FileChange>,
  message: string,
): { commitSha: string; files: Map<string, { oid: string; mode: string }> } {
  let baseTip = branchTip(repo, branch);
  if (baseTip === null && branch !== repo.defaultBranch) baseTip = branchTip(repo, repo.defaultBranch);
  const files = baseTip === null ? new Map<string, { oid: string; mode: string }>() : new Map(commitFiles(repo.objects, baseTip));
  for (const [path, change] of changes) {
    if (change.content === null) {
      files.delete(path);
    } else {
      const oid = storeObject(repo.objects, 'blob', change.content);
      files.set(path, { oid, mode: change.mode ?? files.get(path)?.mode ?? '100644' });
    }
  }
  const tree = buildTreeFromFiles(repo.objects, files);
  const ts = nowSec();
  const ident = viewerIdent(ts);
  const commitData = buildCommitData({
    tree,
    parents: baseTip === null ? [] : [baseTip],
    author: ident,
    committer: ident,
    message,
  });
  const commitSha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = nowIso();
  return { commitSha, files };
}

// --------------------------------------------------------------------------- labels

/** Create a label; answers the existing one when the name is taken. */
export function createLabel(repo: RepoRec, name: string, color?: string, description?: string): LabelRec {
  const existing = repo.labels.get(name);
  if (existing !== undefined) return existing;
  const label: LabelRec = {
    id: forge.nextLabelId,
    name,
    color: (color ?? 'ededed').replace(/^#/, ''),
    description: description ?? '',
  };
  forge.nextLabelId += 1;
  repo.labels.set(name, label);
  return label;
}

// --------------------------------------------------------------------------- issues

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

/** Create an issue; throws a tagged error for an unknown label so callers can answer 422. */
export function createIssue(repo: RepoRec, input: CreateIssueInput): IssueRec {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) {
      const error = new Error(`label "${name}" does not exist`) as Error & { code?: string };
      error.code = 'UNKNOWN_LABEL';
      throw error;
    }
  }
  const ts = nowIso();
  const issue: IssueRec = {
    kind: 'issue',
    id: forge.nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
  };
  forge.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Add a comment to an issue. */
export function addComment(issue: IssueRec, body: string): CommentRec {
  const ts = nowIso();
  const comment: CommentRec = { id: forge.nextCommentId, body, createdAt: ts, updatedAt: ts };
  forge.nextCommentId += 1;
  issue.comments.push(comment);
  issue.updatedAt = ts;
  return comment;
}

// --------------------------------------------------------------------------- pull requests

export interface CreatePullInput {
  title: string;
  body?: string;
  head: string;
  base: string;
}

/** Create a pull request between two existing branches; null when a branch is missing. */
export function createPull(repo: RepoRec, input: CreatePullInput): PullRec | null {
  const headSha = branchTip(repo, input.head);
  const baseSha = branchTip(repo, input.base);
  if (headSha === null || baseSha === null) return null;
  const ts = nowIso();
  const pull: PullRec = {
    kind: 'pull',
    id: forge.nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
  };
  forge.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The files a pull request changes: merge-base tree against the current head tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo.objects, baseTip, headTip);
  const fromFiles = base === null ? new Map<string, { oid: string; mode: string }>() : commitFiles(repo.objects, base);
  const toFiles = commitFiles(repo.objects, headTip);
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
  const paths = new Set([...fromFiles.keys(), ...toFiles.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFiles.get(path);
    const to = toFiles.get(path);
    if (from !== undefined && to === undefined) out.push({ path, status: 'removed', oldOid: from.oid, newOid: null });
    else if (from === undefined && to !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: to.oid });
    else if (from !== undefined && to !== undefined && from.oid !== to.oid) out.push({ path, status: 'modified', oldOid: from.oid, newOid: to.oid });
  }
  return out;
}

/**
 * Three-way tree merge for a squash: merge-base tree against base tip tree against head tip
 * tree. Answers the merged file map, or null when both sides changed a path differently.
 */
export function squashMergeFiles(repo: RepoRec, baseTip: string, headTip: string): Map<string, { oid: string; mode: string }> | null {
  const base = mergeBase(repo.objects, baseTip, headTip);
  const ancestorFiles = base === null ? new Map<string, { oid: string; mode: string }>() : commitFiles(repo.objects, base);
  const baseFiles = commitFiles(repo.objects, baseTip);
  const headFiles = commitFiles(repo.objects, headTip);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const onBase = baseFiles.get(path);
    const onHead = headFiles.get(path);
    const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    let winner: { oid: string; mode: string } | undefined;
    if (same(onHead, ancestor)) winner = onBase;
    else if (same(onBase, ancestor)) winner = onHead;
    else if (same(onHead, onBase)) winner = onHead;
    else return null; // both sides changed the path differently: a conflict
    if (winner !== undefined) merged.set(path, winner);
  }
  return merged;
}

/**
 * Squash-merge a pull request: one new commit on the base branch holding the three-way merged
 * tree. Answers the merge commit id, or null on a conflict. On success the pull is closed,
 * marked merged, and carries the merge sha.
 */
export function mergePull(repo: RepoRec, pull: PullRec): string | null {
  if (pull.merged) return pull.mergeCommitSha;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const mergedFiles = squashMergeFiles(repo, baseTip, headTip);
  if (mergedFiles === null) return null;
  const tree = buildTreeFromFiles(repo.objects, mergedFiles);
  const ts = nowSec();
  const ident = viewerIdent(ts);
  const commitData = buildCommitData({
    tree,
    parents: [baseTip],
    author: ident,
    committer: ident,
    message: `${pull.title} (#${pull.number})`,
  });
  const commitSha = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  const stamp = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = commitSha;
  pull.closedAt = stamp;
  pull.updatedAt = stamp;
  repo.updatedAt = stamp;
  return commitSha;
}

/** Whether a pull request would merge cleanly right now (GraphQL's mergeable). */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'CONFLICTING';
  return squashMergeFiles(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

// --------------------------------------------------------------------------- JSON shapes

/** The REST user object for the viewer. */
export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
  };
}

/** The REST repository object. */
export function repoJson(repo: RepoRec): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://forge.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge.invalid:${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    topics: [],
    language: null,
  };
}

/** The REST label object. */
export function labelJson(label: LabelRec): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

/** The REST issue object. */
export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelJson(label);
    }),
    user: userJson(),
    author: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** The REST comment object. */
export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    author: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

/** The REST pull request object (head/base shas are the tips captured at creation). */
export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    author: userJson(),
    head: side(pull.headRef, pull.headSha),
    base: side(pull.baseRef, pull.baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    draft: false,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Count lines in a blob's text for the pull-files additions/deletions accounting. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Re-export for surfaces that build objects directly. */
export { hashObject };
export type { GitObject };
