import { spawn } from 'node:child_process';
import type { CommitRecord } from './types.js';

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; input?: string },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  headRefName: string;
  authorLogin: string;
  currentUserLogin: string;
  repository: string;
}

export type ResolvePrResult =
  | { kind: 'ok'; branch: string; repoRoot: string; worktreeRoots: string[]; pr: PullRequestInfo; commits: CommitRecord[] }
  | { kind: 'no-pr'; branch: string; message: string };

interface GhPullRequest {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
  commits: GhCommit[];
}

interface GhCommit {
  oid: string;
  messageHeadline: string;
  authoredDate: string;
}

interface LocalCommit {
  sha: string;
  authoredAt: string;
  message: string;
  patchId: string | undefined;
}

const prJsonFields = 'number,url,headRefName,baseRefName,author,commits';

export const defaultCommandRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options?.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        if (exitCode === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(Object.assign(new Error(`${command} failed`), { exitCode, stderr }));
      });

      if (options?.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
  },
};

export async function resolvePullRequest(input: {
  runner?: CommandRunner;
  cwd?: string;
  prNumber?: number;
  branch?: string;
  headSha?: string;
} = {}): Promise<ResolvePrResult> {
  const runner = input.runner ?? defaultCommandRunner;
  let branch = '';
  let cwd = input.cwd;
  let repoRoot = input.cwd ?? '';
  try {
    branch = input.branch ?? (await runner.run('git', ['branch', '--show-current'], { cwd: input.cwd })).stdout.trim();
    repoRoot = (await runner.run('git', ['rev-parse', '--show-toplevel'], { cwd: input.cwd })).stdout.trim();
    cwd = repoRoot || input.cwd;
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return { kind: 'no-pr', branch, message: 'No git repository found for this directory.' };
    }
    throw error;
  }

  let pr: GhPullRequest;
  try {
    pr = await readPullRequest(runner, cwd, input.prNumber, input.branch);
  } catch (error) {
    if (isNoPullRequestError(error)) {
      return { kind: 'no-pr', branch, message: 'No pull request found for current branch.' };
    }
    throw error;
  }

  const repository = repositoryFromPrUrl(pr.url);
  const currentUserLogin = (await readAuthenticatedUserLogin(runner, cwd)) ?? pr.author.login;
  const worktreeRoots = await readWorktreeRoots(runner, cwd, repoRoot || cwd || '');
  const localCommits = await readLocalCommits(runner, cwd, pr.baseRefName, input.headSha);
  const localCommitsBySha = new Map(localCommits.map((commit) => [commit.sha, commit]));
  const localCommitsByPatchId = new Map<string, LocalCommit>();
  for (const commit of localCommits) {
    if (commit.patchId !== undefined) {
      localCommitsByPatchId.set(commit.patchId, commit);
    }
  }
  const commits: CommitRecord[] = [];

  for (const prCommit of pr.commits) {
    const patchId = await readPatchId(runner, cwd, prCommit.oid);
    if (patchId === undefined) {
      const localCommit = localCommitsBySha.get(prCommit.oid);
      if (localCommit === undefined) {
        continue;
      }

      commits.push({
        sha: prCommit.oid,
        message: prCommit.messageHeadline || localCommit.message,
        authorLogin: pr.author.login,
        authoredAt: localCommit.authoredAt || prCommit.authoredDate,
      });
      continue;
    }

    const localCommit = localCommitsByPatchId.get(patchId);
    if (localCommit === undefined) {
      continue;
    }

    commits.push({
      sha: prCommit.oid,
      patchId,
      message: prCommit.messageHeadline || localCommit.message,
      authorLogin: pr.author.login,
      authoredAt: localCommit.authoredAt || prCommit.authoredDate,
    });
  }

  commits.sort((left, right) => Date.parse(left.authoredAt) - Date.parse(right.authoredAt));

  return {
    kind: 'ok',
    branch,
    repoRoot: repoRoot || cwd || '',
    worktreeRoots,
    pr: {
      number: pr.number,
      url: pr.url,
      headRefName: pr.headRefName,
      authorLogin: pr.author.login,
      currentUserLogin,
      repository,
    },
    commits,
  };
}

async function readWorktreeRoots(runner: CommandRunner, cwd: string | undefined, fallbackRoot: string): Promise<string[]> {
  try {
    const result = await runner.run('git', ['worktree', 'list', '--porcelain'], { cwd });
    const roots = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter((root) => root !== '');

    return uniqueStrings([fallbackRoot, ...roots]);
  } catch {
    return uniqueStrings([fallbackRoot]);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

function repositoryFromPrUrl(prUrl: string): string {
  let segments: string[];
  try {
    segments = new URL(prUrl).pathname.split('/').filter((segment) => segment !== '');
  } catch {
    segments = [];
  }

  // gh repo view follows gh's default-repo resolution, which can name a different
  // repository than the PR itself in fork checkouts; the PR url is authoritative.
  if (segments.length < 4 || segments[2] !== 'pull') {
    throw new Error(`Cannot determine repository from pull request url: ${prUrl}`);
  }

  return `${segments[0]}/${segments[1]}`;
}

async function readAuthenticatedUserLogin(runner: CommandRunner, cwd: string | undefined): Promise<string | undefined> {
  try {
    const result = await runner.run('gh', ['api', 'user', '--jq', '.login'], { cwd });
    return result.stdout.trim() || undefined;
  } catch (error) {
    if (isGhSetupError(error)) {
      throw error;
    }

    return undefined;
  }
}

async function readPullRequest(runner: CommandRunner, cwd: string | undefined, prNumber: number | undefined, branch: string | undefined): Promise<GhPullRequest> {
  const selector = prNumber === undefined ? branch : String(prNumber);
  const args = selector === undefined ? ['pr', 'view', '--json', prJsonFields] : ['pr', 'view', selector, '--json', prJsonFields];
  const result = await runner.run('gh', args, { cwd });

  return JSON.parse(result.stdout) as GhPullRequest;
}

async function readLocalCommits(runner: CommandRunner, cwd: string | undefined, baseRefName: string, headSha: string | undefined): Promise<LocalCommit[]> {
  const range = `origin/${baseRefName}..${headSha ?? 'HEAD'}`;
  const result = await runner.run('git', ['log', '--format=%H%x00%aI%x00%s', range], { cwd });
  const commits: LocalCommit[] = [];

  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    const [sha, authoredAt, message] = line.split('\0');
    commits.push({ sha, authoredAt, message, patchId: await readPatchId(runner, cwd, sha) });
  }

  return commits;
}

async function readPatchId(runner: CommandRunner, cwd: string | undefined, sha: string): Promise<string | undefined> {
  const diff = await runner.run('git', ['show', sha, '--pretty=format:'], { cwd });
  const patchId = await runner.run('git', ['patch-id', '--stable'], { cwd, input: diff.stdout });

  return patchId.stdout.trim().split(/\s+/)[0] || undefined;
}

function isNoPullRequestError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const detail = errorDetail(error);

  return (
    detail.includes('no pull requests found') ||
    detail.includes('no git remotes found') ||
    detail.includes('no repository found')
  );
}

function isNotGitRepositoryError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && errorDetail(error).includes('not a git repository');
}

function isGhSetupError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const detail = errorDetail(error);

  return (
    detail.includes('spawn gh enoent') ||
    detail.includes('gh: command not found') ||
    detail.includes('gh auth login') ||
    detail.includes('authentication required')
  );
}

function errorDetail(error: object): string {
  const message = error instanceof Error ? error.message : '';
  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr) : '';

  return `${message}\n${stderr}`.toLowerCase();
}
