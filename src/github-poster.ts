import type { CommandRunner } from './git-resolver.js';

const prtokensMarker = '<!-- prtokens:v1 -->';

interface IssueComment {
  id: number | string;
  body: string;
}

export async function ensureGhReady(runner: CommandRunner): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await runner.run('gh', ['auth', 'status']);
    return { ok: true };
  } catch {
    return { ok: false, message: 'Install GitHub CLI and run gh auth login.' };
  }
}

export async function upsertPrComment(input: {
  runner: CommandRunner;
  repository: string;
  prNumber: number;
  markdown: string;
}): Promise<{ ok: true; commentUrl?: string } | { ok: false; renderedMarkdown: string; error: string }> {
  let comments: IssueComment[];

  try {
    const result = await input.runner.run('gh', ['api', `repos/${input.repository}/issues/${input.prNumber}/comments`]);
    comments = parseIssueComments(result.stdout);
  } catch (error) {
    return { ok: false, renderedMarkdown: input.markdown, error: safeErrorMessage(error) };
  }

  const existingComment = comments.find((comment) => comment.body.includes(prtokensMarker));
  const args = existingComment
    ? ['api', '--method', 'PATCH', `repos/${input.repository}/issues/comments/${existingComment.id}`, '-f', `body=${input.markdown}`]
    : ['api', '--method', 'POST', `repos/${input.repository}/issues/${input.prNumber}/comments`, '-f', `body=${input.markdown}`];

  try {
    const result = await input.runner.run('gh', args);
    return { ok: true, commentUrl: parseCommentUrl(result.stdout) };
  } catch (error) {
    return { ok: false, renderedMarkdown: input.markdown, error: safeErrorMessage(error) };
  }
}

function parseIssueComments(stdout: string): IssueComment[] {
  try {
    const value = JSON.parse(stdout) as unknown;

    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(isIssueComment);
  } catch {
    return [];
  }
}

function isIssueComment(value: unknown): value is IssueComment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const comment = value as { id?: unknown; body?: unknown };
  return (typeof comment.id === 'number' || typeof comment.id === 'string') && typeof comment.body === 'string';
}

function parseCommentUrl(stdout: string): string | undefined {
  try {
    const value = JSON.parse(stdout) as { html_url?: unknown };
    return typeof value.html_url === 'string' ? value.html_url : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'GitHub CLI command failed.';
}
