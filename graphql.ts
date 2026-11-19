// GitHub GraphQL v4 at POST /api/graphql: a hand-written tokenizer, parser and executor for the
// documents gh and github-mcp-server send (viewer, repository reads, issue and pull-request
// connections with cursor pagination, the create/close/merge/comment mutations, node(id:),
// __type introspection, and operation batching). Unknown fields are GraphQL errors on a 200,
// unknown repositories are data.repository = null with no errors, and global ids are the same
// opaque ids the REST surface reports as node_id.

import type { ServerResponse } from 'node:http';
import {
  addComment,
  branchTip,
  createIssue,
  createPull,
  findRepo,
  findRepoById,
  mergePull,
  pullFiles,
  pullMergeable,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { VIEWER, globalId, nowIso, parseGlobalId, sendJson } from './util.ts';

// --------------------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[escaped] ?? escaped;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      const value = Number(text);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const variable = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(variable, this.parseValue());
            this.parseDirectives();
          }
        }
        this.parseDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragmentName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragmentName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  /** Parse and discard a type reference (`String!`, `[IssueState!]`, ...). */
  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> {
    const directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!this.skipPunct(']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.skipPunct('}')) {
            const fieldName = this.expectName();
            this.expectPunct(':');
            fields.push({ name: fieldName, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        break;
      default:
        break;
    }
    throw new Error('unexpected value');
  }
}

// --------------------------------------------------------------------------- schema tables (introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'user', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url', 'isFork', 'isArchived', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'createdAt', 'updatedAt',
    'closed', 'closedAt', 'comments', 'labels', 'url', 'viewerCanUpdate',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
    'additions', 'deletions', 'changedFiles', 'closed', 'url',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'committedDate', 'author'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// --------------------------------------------------------------------------- execution

type GqlObject = { __typename: string; [key: string]: unknown };

interface ExecContext {
  variables: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: DocumentNode['fragments'];
  errors: Array<{ message: string }>;
}

class FieldError extends Error {}

function evalValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const fallback = ctx.defaults.get(node.name);
      return fallback === undefined ? null : evalValue(fallback, ctx);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, ctx);
  return out;
}

function userObject(): GqlObject {
  return { __typename: 'User' };
}

function repoObject(repo: RepoRec): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: RepoRec, issue: IssueRec): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: RepoRec, pull: PullRec): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Resolve one field on one object; throws FieldError for a field the type does not hold. */
function resolveField(object: GqlObject, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const type = object.__typename;

  // Plain data wrappers (connections, page info, payloads) carry their fields as properties.
  if (type.endsWith('Connection') || type === 'PageInfo' || type.endsWith('Payload') || type.endsWith('Edge')) {
    if (field in object) return object[field];
    throw new FieldError(`Field '${field}' doesn't exist on type '${type}'`);
  }

  switch (type) {
    case 'Query':
      return resolveQuery(field, args);
    case 'Mutation':
      return resolveMutation(field, args);
    case 'User':
      switch (field) {
        case 'login': return VIEWER.login;
        case 'id': return globalId('User', VIEWER.id);
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        case 'avatarUrl': return '';
        case 'url': return `https://forge.invalid/${VIEWER.login}`;
        default: break;
      }
      break;
    case 'Repository':
      return resolveRepository(object.repo as RepoRec, field, args);
    case 'Issue': {
      const repo = object.repo as RepoRec;
      const issue = object.issue as IssueRec;
      switch (field) {
        case 'id': return globalId('Issue', repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author': return userObject();
        case 'repository': return repoObject(repo);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closed': return issue.state === 'closed';
        case 'closedAt': return issue.closedAt;
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'viewerCanUpdate': return true;
        case 'comments':
          return {
            __typename: 'CommentConnection',
            nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: issue.comments.length,
          };
        case 'labels':
          return {
            __typename: 'LabelConnection',
            nodes: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? '' })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: issue.labels.length,
          };
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const repo = object.repo as RepoRec;
      const pull = object.pull as PullRec;
      switch (field) {
        case 'id': return globalId('PullRequest', repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'author': return userObject();
        case 'repository': return repoObject(repo);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'mergedAt': return pull.mergedAt;
        case 'closed': return pull.state === 'closed';
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha, id: pull.mergeCommitSha };
        case 'files': {
          const files = pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : files.length;
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path, additions: 0, deletions: 0, changeType: file.status.toUpperCase() })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: files.length,
          };
        }
        case 'additions':
        case 'deletions':
        case 'changedFiles': {
          const files = pullFiles(repo, pull);
          return field === 'changedFiles' ? files.length : 0;
        }
        default: break;
      }
      break;
    }
    case 'IssueComment': {
      const repo = object.repo as RepoRec;
      const issue = object.issue as IssueRec;
      const comment = object.comment as { id: number; body: string; createdAt: string; updatedAt: string };
      switch (field) {
        case 'id': return globalId('IssueComment', repo.id, issue.number, comment.id);
        case 'body': return comment.body;
        case 'author': return userObject();
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.updatedAt;
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`;
        default: break;
      }
      break;
    }
    case 'Ref':
      if (field === 'name') return object.name;
      if (field === 'target') return { __typename: 'Commit', oid: object.oid ?? null, id: object.oid ?? null };
      if (field === 'repository') return object.repo !== undefined ? repoObject(object.repo as RepoRec) : null;
      break;
    case 'Commit':
      if (field === 'oid' || field === 'id') return object.oid;
      if (field === 'message') return '';
      if (field === 'committedDate') return null;
      if (field === 'author') return userObject();
      break;
    case 'Label':
      if (field === 'id') return globalId('Label', String(object.name));
      if (field === 'name' || field === 'color' || field === 'description') return object[field];
      break;
    case 'PullRequestChangedFile':
      if (field === 'path' || field === 'additions' || field === 'deletions' || field === 'changeType') return object[field];
      break;
    case '__Type':
      return resolveType(object, field);
    case '__Schema':
      if (field === 'queryType') return typeObject('Query');
      if (field === 'mutationType') return typeObject('Mutation');
      if (field === 'types') return Object.keys(TYPE_FIELDS).map((name) => typeObject(name));
      if (field === 'directives') return [];
      break;
    case '__Field':
      if (field === 'name') return object.name;
      if (field === 'description') return null;
      if (field === 'type') return typeObject('String');
      if (field === 'args') return [];
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    case '__EnumValue':
      if (field === 'name') return object.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    default:
      break;
  }
  void ctx;
  throw new FieldError(`Field '${field}' doesn't exist on type '${type}'`);
}

function typeObject(name: string): GqlObject {
  return { __typename: '__Type', name };
}

function resolveType(object: GqlObject, field: string): unknown {
  const name = object.name as string;
  switch (field) {
    case 'name':
      return name;
    case 'kind':
      return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
    case 'description':
      return null;
    case 'fields':
      return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    case 'enumValues':
      return (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
    case 'possibleTypes':
      return [];
    case 'inputFields':
      return [];
    case 'ofType':
      return null;
    case 'interfaces':
      return [];
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type '__Type'`);
  }
}

function resolveRepository(repo: RepoRec, field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'id': return globalId('Repository', repo.id);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'owner': return userObject();
    case 'defaultBranchRef': {
      const tip = branchTip(repo, repo.defaultBranch);
      return { __typename: 'Ref', name: repo.defaultBranch, oid: tip, repo };
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'description': return repo.description;
    case 'isPrivate': return repo.isPrivate;
    case 'isFork': return false;
    case 'isArchived': return false;
    case 'stargazerCount': return 0;
    case 'forkCount': return 0;
    case 'createdAt': return repo.createdAt;
    case 'updatedAt': return repo.updatedAt;
    case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}`;
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const descending = orderBy?.direction === 'DESC';
      issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      let start = 0;
      const afterNumber = numberOfCursor(args.after);
      if (afterNumber !== null) {
        const index = issues.findIndex((issue) => issue.number === afterNumber);
        if (index >= 0) start = index + 1;
      }
      const first = typeof args.first === 'number' ? args.first : issues.length;
      const slice = issues.slice(start, start + Math.max(0, first));
      return {
        __typename: 'IssueConnection',
        nodes: slice.map((issue) => issueObject(repo, issue)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: start + slice.length < issues.length,
          hasPreviousPage: start > 0,
          startCursor: slice.length > 0 ? cursorOf(slice[0].number) : null,
          endCursor: slice.length > 0 ? cursorOf(slice[slice.length - 1].number) : null,
        },
        totalCount: issues.length,
      };
    }
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullObject(repo, pull);
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return states.includes(state);
        });
      }
      pulls.sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      const slice = pulls.slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestConnection',
        nodes: slice.map((pull) => pullObject(repo, pull)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: pulls.length > slice.length,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: pulls.length,
      };
    }
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'Repository'`);
  }
}

function resolveQuery(field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'viewer':
      return userObject();
    case 'user': {
      const login = typeof args.login === 'string' ? args.login : '';
      return login === VIEWER.login ? userObject() : null;
    }
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = findRepo(owner, name);
      return repo === null ? null : repoObject(repo);
    }
    case 'node': {
      const id = typeof args.id === 'string' ? args.id : '';
      return nodeById(id);
    }
    case '__type': {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return typeObject(name);
    }
    case '__schema':
      return { __typename: '__Schema' };
    case 'rateLimit':
      return { __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: nowIso(), nodeCount: 0 };
    case 'search':
      return { __typename: 'SearchType', issueCount: 0, repositoryCount: 0, userCount: 0, nodes: [], edges: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'Query'`);
  }
}

/** Resolve a Relay global id to its object (repository, issue, pull request, comment, user). */
function nodeById(id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'User') return userObject();
  if (parsed.kind === 'Repository') {
    const repo = findRepoById(Number(parsed.parts[0]));
    return repo === null ? null : repoObject(repo);
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest' || parsed.kind === 'IssueComment') {
    const repo = findRepoById(Number(parsed.parts[0]));
    if (repo === null) return null;
    const number = Number(parsed.parts[1]);
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (parsed.kind === 'PullRequest') {
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullObject(repo, pull);
    }
    const issue = repo.issues.get(number);
    if (issue === undefined) return null;
    const comment = issue.comments.find((candidate) => candidate.id === Number(parsed.parts[2]));
    return comment === undefined ? null : { __typename: 'IssueComment', repo, issue, comment };
  }
  return null;
}

function repoFromGlobalId(id: unknown): RepoRec {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoById(Number(parsed.parts[0])) : null;
  if (repo === null) throw new FieldError('Could not resolve the repository id');
  return repo;
}

function issueFromGlobalId(id: unknown): { repo: RepoRec; issue: IssueRec } {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  const repo = parsed !== null && parsed.kind === 'Issue' ? findRepoById(Number(parsed.parts[0])) : null;
  const issue = repo?.issues.get(Number(parsed?.parts[1]));
  if (repo === null || issue === undefined) throw new FieldError('Could not resolve the issue id');
  return { repo, issue };
}

function pullFromGlobalId(id: unknown): { repo: RepoRec; pull: PullRec } {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  const repo = parsed !== null && parsed.kind === 'PullRequest' ? findRepoById(Number(parsed.parts[0])) : null;
  const pull = repo?.pulls.get(Number(parsed?.parts[1]));
  if (repo === null || pull === undefined) throw new FieldError('Could not resolve the pull request id');
  return { repo, pull };
}

function resolveMutation(field: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const repo = repoFromGlobalId(input.repositoryId);
      const issue = createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'closeIssue': {
      const { repo, issue } = issueFromGlobalId(input.issueId);
      issue.state = 'closed';
      issue.closedAt = nowIso();
      issue.updatedAt = issue.closedAt;
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'reopenIssue': {
      const { repo, issue } = issueFromGlobalId(input.issueId);
      issue.state = 'open';
      issue.closedAt = null;
      return { __typename: 'ReopenIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'createPullRequest': {
      const repo = repoFromGlobalId(input.repositoryId);
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const pull = createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
      });
      if (pull === null) throw new FieldError('Could not create the pull request: head or base branch does not exist');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'mergePullRequest': {
      const { repo, pull } = pullFromGlobalId(input.pullRequestId);
      if (!pull.merged) {
        const sha = mergePull(repo, pull);
        if (sha === null) throw new FieldError('Pull request is not mergeable');
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'addComment': {
      const { repo, issue } = issueFromGlobalId(input.subjectId);
      const comment = addComment(issue, typeof input.body === 'string' ? input.body : '');
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: { __typename: 'IssueComment', repo, issue, comment } },
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'Mutation'`);
  }
}

/** Expand a selection set against an object's type, resolving fragment spreads and conditions. */
function collectFields(object: GqlObject, selections: readonly SelectionNode[], ctx: ExecContext): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      fields.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === object.__typename) {
        fields.push(...collectFields(object, selection.selectionSet, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === object.__typename)) {
        fields.push(...collectFields(object, fragment.selectionSet, ctx));
      }
    }
  }
  return fields;
}

/** Whether a field's directives keep it (@skip/@include with a literal or variable `if`). */
function fieldIncluded(field: FieldNode, ctx: ExecContext): boolean {
  for (const directive of field.directives) {
    const ifArg = directive.args.find((arg) => arg.name === 'if');
    const value = ifArg === undefined ? null : evalValue(ifArg.value, ctx);
    if (directive.name === 'skip' && value === true) return false;
    if (directive.name === 'include' && value === false) return false;
  }
  return true;
}

/** Complete a resolved value against a selection set. */
function completeValue(value: unknown, selectionSet: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selectionSet, ctx));
  if (typeof value === 'object') {
    const object = value as GqlObject;
    if (typeof object.__typename !== 'string') return value;
    if (selectionSet === null) return {};
    const out: Record<string, unknown> = {};
    for (const field of collectFields(object, selectionSet, ctx)) {
      if (!fieldIncluded(field, ctx)) continue;
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[key] = object.__typename;
        continue;
      }
      try {
        const resolved = resolveField(object, field.name, argsOf(field, ctx), ctx);
        out[key] = completeValue(resolved, field.selectionSet, ctx);
      } catch (error) {
        if (error instanceof FieldError) {
          ctx.errors.push({ message: error.message });
          out[key] = null;
        } else {
          throw error;
        }
      }
    }
    return out;
  }
  return value;
}

/** Execute one operation document; answers the {data, errors?} envelope. */
function executeOne(document: string, variables: Record<string, unknown>, operationName: string | null): Record<string, unknown> {
  let parsed: DocumentNode;
  try {
    parsed = new Parser(document).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = parsed.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };
  const ctx: ExecContext = { variables, defaults: operation.variableDefaults, fragments: parsed.fragments, errors: [] };
  const root: GqlObject = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = completeValue(root, operation.selectionSet, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** POST /api/graphql: one operation, or a JSON array of them answered in order. */
export function handleGraphQL(res: ServerResponse, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const operation = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
      return executeOne(
        typeof operation.query === 'string' ? operation.query : '',
        (operation.variables ?? {}) as Record<string, unknown>,
        typeof operation.operationName === 'string' ? operation.operationName : null,
      );
    });
    sendJson(res, 200, results);
    return;
  }
  const operation = (parsed ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  const result = executeOne(
    typeof operation.query === 'string' ? operation.query : '',
    (operation.variables ?? {}) as Record<string, unknown>,
    typeof operation.operationName === 'string' ? operation.operationName : null,
  );
  sendJson(res, 200, result);
}
