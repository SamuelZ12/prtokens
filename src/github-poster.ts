import type { CommandRunner } from './git-resolver.js';

const prtokensMarker = '<!-- prtokens:v1 -->';

interface IssueComment {
  id: number | string;
  body: string;
}

type ParseCommentsResult = { ok: true; comments: IssueComment[] } | { ok: false; error: string };

type UpsertPrCommentInput = {
  runner: CommandRunner;
  repository: string;
  prNumber: number;
} & ({ markdown: string; renderMarkdown?: never } | { markdown?: string; renderMarkdown(existingBody?: string): string });

export async function ensureGhReady(runner: CommandRunner): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await runner.run('gh', ['auth', 'status']);
    return { ok: true };
  } catch {
    return { ok: false, message: 'Install GitHub CLI and run gh auth login.' };
  }
}

export async function upsertPrComment(
  input: UpsertPrCommentInput,
): Promise<{ ok: true; commentUrl?: string } | { ok: false; renderedMarkdown: string; error: string }> {
  let renderedMarkdown = input.markdown ?? '';
  let comments: IssueComment[];

  try {
    const result = await input.runner.run('gh', ['api', `repos/${input.repository}/issues/${input.prNumber}/comments`]);
    const parsed = parseIssueComments(result.stdout);
    if (!parsed.ok) {
      renderedMarkdown = renderMarkdown(input, undefined);
      return { ok: false, renderedMarkdown, error: parsed.error };
    }

    comments = parsed.comments;
  } catch (error) {
    renderedMarkdown = renderMarkdown(input, undefined);
    return { ok: false, renderedMarkdown, error: safeErrorMessage(error) };
  }

  const existingComments = comments.filter((comment) => comment.body.includes(prtokensMarker));
  const existingComment = existingComments[0];
  renderedMarkdown = renderMarkdown(input, existingComment?.body);
  const args = existingComment
    ? ['api', '--method', 'PATCH', `repos/${input.repository}/issues/comments/${existingComment.id}`, '-f', `body=${renderedMarkdown}`]
    : ['api', '--method', 'POST', `repos/${input.repository}/issues/${input.prNumber}/comments`, '-f', `body=${renderedMarkdown}`];

  try {
    const result = await input.runner.run('gh', args);
    for (const duplicate of existingComments.slice(1)) {
      await input.runner.run('gh', ['api', '--method', 'DELETE', `repos/${input.repository}/issues/comments/${duplicate.id}`]);
    }

    const commentUrl = parseCommentUrl(result.stdout);
    return commentUrl === undefined ? { ok: true } : { ok: true, commentUrl };
  } catch (error) {
    return { ok: false, renderedMarkdown, error: safeErrorMessage(error) };
  }
}

function renderMarkdown(input: UpsertPrCommentInput, existingBody: string | undefined): string {
  return input.renderMarkdown === undefined ? input.markdown : input.renderMarkdown(existingBody);
}

function parseIssueComments(stdout: string): ParseCommentsResult {
  try {
    const value = JSON.parse(stdout) as unknown;

    if (!Array.isArray(value)) {
      return { ok: false, error: 'GitHub comments response was not an array.' };
    }

    const comments: IssueComment[] = [];
    for (const entry of value) {
      const body = readCommentBody(entry);
      if (body?.includes(prtokensMarker) && !hasCommentId(entry)) {
        return { ok: false, error: 'Found an existing prtokens comment without a usable id.' };
      }

      if (isIssueComment(entry)) {
        comments.push(entry);
      }
    }

    return { ok: true, comments };
  } catch {
    return { ok: false, error: 'GitHub comments response was not valid JSON.' };
  }
}

function readCommentBody(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const body = (value as { body?: unknown }).body;
  return typeof body === 'string' ? body : undefined;
}

function hasCommentId(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const id = (value as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string';
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
