# Near-Instant PR Posting Design

## Problem

The optional `prtokens init` pre-push hook currently records a pushed branch in the local pending queue and then starts a detached queue worker. This keeps `git push` fast, but it can delay the PR cost comment. In a recent run, the PR was created at `00:58:31Z` and the comment appeared at `00:59:05Z`, a 34 second delay.

That delay is too long for the expected UX. When a branch already has an open PR, the cost comment should appear as close to immediately as possible after the push.

## Goals

- Post the PR comment in the same hook-triggered process when possible.
- Keep local transcript privacy unchanged; do not move cost computation to GitHub Actions.
- Preserve the pending queue for branches pushed before a PR exists.
- Avoid blocking or failing the user's push because posting fails.
- Keep `prtokens status` useful for pending, blocked, failed, and completed automatic jobs.

## Non-Goals

- Do not introduce GitHub Actions as the primary posting path.
- Do not upload local transcripts or raw usage data to GitHub.
- Do not remove the queue or retry behavior.
- Do not change manual `prtokens` posting semantics.

## User Experience

For the common case where a branch already has an open PR:

1. User pushes commits.
2. The pre-push hook records the job.
3. The same `prtokens __hook-pushed-ref` command immediately processes the queue once.
4. If GitHub can resolve the PR and usage exists, the comment is posted before the hook command exits.
5. Hook failures remain non-fatal to `git push`.

For the case where the branch is pushed before the PR exists:

1. The immediate queue processing returns `No pull request found for current branch.`
2. The job remains pending.
3. A detached background worker continues retrying for the existing retry window.
4. When a PR appears and the branch SHA still matches, the worker posts the comment.

For `prtokens pr create`, the existing behavior remains: run `gh pr create`, then post the comment immediately after successful PR creation.

## Architecture

The existing queue remains the source of truth. The change is in scheduling:

- `runHookPushedRef` continues to enqueue the pushed ref.
- `scheduleProcessQueue` should process the queue immediately in the current process.
- If retryable pending jobs remain after the immediate pass, `scheduleProcessQueue` should also spawn the detached worker as a fallback.
- The hook wrapper still redirects command output to `/dev/null` and ignores errors, so posting problems do not break pushes.

This gives near-instant posting when the PR already exists, while preserving delayed retry for newly pushed branches that get a PR shortly afterward.

## Error Handling

- `posted` marks the job completed with `posted PR #<number>`.
- `no-pr` leaves the job pending and schedules background retry.
- `no-usage` marks the job completed with `no usage found`.
- `gh-not-ready` marks the job blocked with the setup message.
- `post-failed` marks the job failed with the GitHub API error.
- Exceptions during immediate processing are caught by the existing scheduling boundary and do not affect the push.

## Testing

- Add or update CLI tests for `__hook-pushed-ref` to verify it processes immediately.
- Verify no detached worker is needed when immediate processing completes all jobs.
- Verify a detached worker is still spawned when a job remains pending because no PR exists yet.
- Keep existing pending queue worker tests unchanged unless the scheduling seam requires small updates.

## Success Criteria

- For an already-open PR, automatic posting happens during the hook-triggered command instead of only in a detached process.
- `prtokens status` shows the completed post immediately after push in normal conditions.
- Existing tests pass, and new tests cover immediate processing and pending fallback.
