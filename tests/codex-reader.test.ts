import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexUsage } from '../src/codex-reader.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prtokens-codex-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readCodexUsage', () => {
  it('reads token_count deltas for matching repo sessions', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/samuelzhang/Documents/GitHub/prtokens';
    const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '06', '12');
    await mkdir(sessionDir, { recursive: true });

    await writeFile(
      join(sessionDir, 'rollout.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-12T09:59:59.000Z',
          type: 'session_meta',
          payload: { id: 's1', cwd: repoRoot, git: { branch: 'feature/prtokens' } },
        }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({
          timestamp: '2026-06-12T10:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 25,
                output_tokens: 40,
                total_tokens: 165,
              },
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 25,
                output_tokens: 40,
                total_tokens: 165,
              },
            },
          },
        }),
      ].join('\n'),
    );

    const result = await readCodexUsage({ repoRoot, homeDir });

    expect(result.events).toEqual([
      {
        id: 'codex-rollout:s1:2026-06-12T10:00:00.000Z:165',
        agent: 'codex',
        timestamp: '2026-06-12T10:00:00.000Z',
        model: 'gpt-5.5',
        inputTokens: 75,
        cacheReadTokens: 25,
        outputTokens: 40,
        cacheWriteTokens: 0,
        sessionId: 's1',
        gitBranch: 'feature/prtokens',
      },
    ]);
    expect(result.diagnostics.scannedFileCount).toBe(1);
  });

  it('skips cwd mismatches, null info token counts, and metadata-less files', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const sessionsDir = join(homeDir, '.codex', 'sessions');
    await mkdir(join(sessionsDir, 'mismatch'), { recursive: true });
    await mkdir(join(sessionsDir, 'metadata-less'), { recursive: true });

    await writeFile(
      join(sessionsDir, 'mismatch', 'rollout.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 's-other', cwd: '/Users/me/other' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({
          timestamp: '2026-06-12T10:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } } },
        }),
      ].join('\n'),
    );
    await writeFile(
      join(sessionsDir, 'metadata-less', 'rollout.jsonl'),
      [
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({ timestamp: '2026-06-12T10:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
        JSON.stringify({
          timestamp: '2026-06-12T10:06:00.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } } },
        }),
      ].join('\n'),
    );

    const result = await readCodexUsage({ repoRoot, homeDir });

    expect(result.events).toHaveLength(0);
    expect(result.diagnostics.skippedLineCount).toBeGreaterThanOrEqual(2);
  });

  it('recovers legacy cumulative-only deltas and clamps cached input to input', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const sessionDir = join(homeDir, '.codex', 'sessions');
    await mkdir(sessionDir, { recursive: true });

    await writeFile(
      join(sessionDir, 'legacy.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'legacy-1', cwd: repoRoot } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({
          timestamp: '2026-06-12T10:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 20, output_tokens: 5, total_tokens: 35 } },
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-12T10:01:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 30, output_tokens: 8, total_tokens: 58 } },
          },
        }),
      ].join('\n'),
    );

    const result = await readCodexUsage({ repoRoot, homeDir });

    expect(result.events.map((event) => event.cacheReadTokens)).toEqual([10, 10]);
    expect(result.events.map((event) => event.inputTokens)).toEqual([0, 0]);
    expect(result.events.map((event) => event.outputTokens)).toEqual([5, 3]);
  });

  it('dedupes resumed sessions and lets active sessions override archived sessions with same relative path', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const relativePath = join('2026', '06', '12', 'rollout.jsonl');
    const activePath = join(homeDir, '.codex', 'sessions', relativePath);
    const archivedPath = join(homeDir, '.codex', 'archived_sessions', relativePath);
    await mkdir(join(activePath, '..'), { recursive: true });
    await mkdir(join(archivedPath, '..'), { recursive: true });
    const activeRollout = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'resumed-1', cwd: repoRoot } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      JSON.stringify({
        timestamp: '2026-06-12T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 } },
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-12T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 } },
        },
      }),
    ].join('\n');
    await writeFile(activePath, activeRollout);
    await writeFile(
      archivedPath,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'archived-should-not-read', cwd: repoRoot } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({
          timestamp: '2026-06-12T09:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 99, cached_input_tokens: 0, output_tokens: 1, total_tokens: 100 } },
          },
        }),
      ].join('\n'),
    );

    const result = await readCodexUsage({ repoRoot, homeDir });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.sessionId).toBe('resumed-1');
    expect(result.diagnostics.dedupedEventCount).toBe(1);
  });

  it('returns no events and no warnings when Codex storage is missing', async () => {
    const homeDir = await createTempDir();

    const result = await readCodexUsage({ repoRoot: '/Users/me/repo', homeDir });

    expect(result.events).toEqual([]);
    expect(result.diagnostics.scannedFileCount).toBe(0);
    expect(result.diagnostics.malformedLineCount).toBe(0);
  });
});
