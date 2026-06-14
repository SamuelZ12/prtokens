# Pending PR Queue and PR Create Fast Path Design

## Goal

Make `prtokens` reliably post a PR cost breakdown for the common local workflow:

1. Create a branch.
2. Commit changes.
3. Run `git push -u origin <branch>`.
4. Run `gh pr create`.

The current global `pre-push` hook runs before the PR exists, so it can miss this workflow. The v1 fix keeps the product local-only and avoids a daemon, GitHub App, GitHub Action, or transparent `gh` interception.

## Product Promise

With the hook installed, `prtokens` automatically comments open PRs after pushes and watches recently pushed branches for PRs created shortly afterward. For guaranteed immediate posting at PR creation time, users can run `prtokens pr create -- <gh pr create args>` or configure an explicit `gh` alias.

## Scope

### In Scope

- Durable local pending-PR queue created from the `pre-push` path when no PR exists yet.
- Bounded background retry worker for queued pushed branches.
- `prtokens pr create -- <args>` command that wraps `gh pr create` and posts after a successful PR creation.
- `prtokens status` command that displays queued, blocked, failed, and completed queue items.
- Documentation updates that explain the automatic hook behavior and the explicit fast path.

### Out of Scope

- Long-lived daemon, LaunchAgent, or background service.
- GitHub App or GitHub Action as the primary posting path.
- Replacing, shadowing, or transparently intercepting the user's `gh` binary.
- Storing transcripts or detailed usage data in the queue.

## Architecture

Add a small queue module responsible for storing pending PR post jobs under a user-local application data directory. The queue stores metadata only:

- repository root
- GitHub repository identifier when available
- remote name and URL
- local branch name
- remote branch name
- queued head SHA
- queued time
- last attempt time
- attempt count
- status: `pending`, `blocked`, `completed`, or `failed`
- last result message

The queue never stores coding-agent transcripts, raw token usage, prompts, completions, or rendered comments.

The existing CLI posting flow remains the source of truth for attribution, rendering, and comment upsert. New queue and wrapper paths should call the same internal posting operation rather than duplicating comment logic.

## Pre-Push Queue Flow

When the installed `pre-push` hook fires, it should continue to run asynchronously and never block or fail the user's push because of `prtokens`.

For each pushed branch ref, `prtokens` should:

1. Wait briefly for the remote ref to become visible, as the hook does today.
2. Try to resolve an open PR for the pushed branch.
3. If a PR exists, post or update the normal PR comment.
4. If no PR exists, enqueue a pending job for that repository, branch, remote branch, and head SHA.
5. Start a detached bounded worker that retries pending jobs.

The worker should retry for 30 minutes after the push. Queue records remain visible for 24 hours so users can diagnose missed or blocked work with `prtokens status`.

## Queue Retry Behavior

For each pending job, the worker should:

1. Re-open the repository at the stored repository root.
2. Resolve the PR for the stored branch or remote branch, not the user's current checkout.
3. Skip stale work if the branch has moved away from the queued head SHA before a PR appears.
4. Post or update the PR comment when the matching PR appears.
5. Mark the job `completed` when posting succeeds or when there is no attributable usage.
6. Mark the job `blocked` when local prerequisites are missing, such as missing `gh` authentication.
7. Mark the job `failed` for unrecoverable errors.

Retries must be idempotent. If both the queue and another path post for the same PR, the existing marker-based comment update should keep one `prtokens` comment.

## PR Create Fast Path

Add:

```bash
prtokens pr create -- <gh pr create args>
```

This command should:

1. Run `gh pr create <args>` with inherited stdio.
2. Preserve the `gh pr create` exit code if PR creation fails.
3. If PR creation succeeds, resolve the created PR for the current branch.
4. Post or update the `prtokens` comment immediately.
5. Report comment-posting failures without turning a successful PR creation into a failed command.

This is the deterministic local-only path for users who want immediate posting at PR creation time. The command is explicit; `prtokens` should not transparently replace `gh`.

## Status Command

Add:

```bash
prtokens status
```

It should print a concise summary of queue records grouped by state:

- pending jobs, with branch, short SHA, age, attempts, and last result
- blocked jobs, with the action needed when known
- failed jobs, with the last error
- recently completed jobs, including `posted` or `no usage found`

If the queue is empty, it should say that there are no pending PR posts.

## Error Handling

- Pushes must remain non-blocking. Hook-triggered failures are recorded in the queue and surfaced through `prtokens status`.
- Missing or expired GitHub CLI authentication marks a job `blocked`.
- No coding-agent usage marks the job `completed` with a `no-usage` result.
- Force-pushed or moved branches should prevent stale queued work from posting an outdated breakdown.
- Multiple pushed refs should be handled independently.
- Existing manual CLI behavior should remain available as a fallback.

## Testing

Add tests before implementation for:

- Queue records are written when no PR exists during hook-triggered posting.
- Queue worker posts when a PR appears within the retry window.
- Queue worker does not post stale work after the branch head changes.
- `prtokens pr create -- <args>` runs `gh pr create` and posts after success.
- `prtokens pr create` does not fail PR creation when only comment posting fails.
- `prtokens status` displays pending, blocked, failed, completed, and empty states.
- Existing hook installation behavior still preserves unrelated hook content.

## Acceptance Criteria

- `git push -u origin <branch>` followed by `gh pr create` within 30 minutes produces one `prtokens` PR comment without a manual `prtokens` run.
- `prtokens pr create -- <args>` posts or updates the PR comment before exiting after successful PR creation.
- Queue storage contains only metadata and no transcript or usage content.
- Duplicate triggers still produce exactly one marker-based `prtokens` comment.
- `prtokens status` explains pending, blocked, failed, completed, and empty queue states.
- The installed hook never blocks or fails a push because `prtokens` cannot post.
