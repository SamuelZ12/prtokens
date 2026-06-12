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
  | { kind: 'ok'; branch: string; pr: PullRequestInfo; commits: CommitRecord[] }
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
} = {}): Promise<ResolvePrResult> {
  const runner = input.runner ?? defaultCommandRunner;
  let branch = '';
  let cwd = input.cwd;
  try {
    branch = (await runner.run('git', ['branch', '--show-current'], { cwd: input.cwd })).stdout.trim();
    const repoRoot = (await runner.run('git', ['rev-parse', '--show-toplevel'], { cwd: input.cwd })).stdout.trim();
    cwd = repoRoot || input.cwd;
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return { kind: 'no-pr', branch, message: 'No git repository found for this directory.' };
    }
    throw error;
  }

  let pr: GhPullRequest;
  try {
    pr = await readPullRequest(runner, cwd, input.prNumber);
  } catch (error) {
    if (isNoPullRequestError(error)) {
      return { kind: 'no-pr', branch, message: 'No pull request found for current branch.' };
    }
    throw error;
  }

  const repository = JSON.parse((await runner.run('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd })).stdout) as {
    nameWithOwner: string;
  };
  const currentUserLogin = (await readAuthenticatedUserLogin(runner, cwd)) ?? pr.author.login;
  const localCommits = await readLocalCommits(runner, cwd, pr.baseRefName);
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
    pr: {
      number: pr.number,
      url: pr.url,
      headRefName: pr.headRefName,
      authorLogin: pr.author.login,
      currentUserLogin,
      repository: repository.nameWithOwner,
    },
    commits,
  };
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

async function readPullRequest(runner: CommandRunner, cwd: string | undefined, prNumber: number | undefined): Promise<GhPullRequest> {
  const args = prNumber === undefined ? ['pr', 'view', '--json', prJsonFields] : ['pr', 'view', String(prNumber), '--json', prJsonFields];
  const result = await runner.run('gh', args, { cwd });

  return JSON.parse(result.stdout) as GhPullRequest;
}

async function readLocalCommits(runner: CommandRunner, cwd: string | undefined, baseRefName: string): Promise<LocalCommit[]> {
  const range = `origin/${baseRefName}..HEAD`;
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
