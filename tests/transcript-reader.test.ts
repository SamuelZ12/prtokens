import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeTranscripts } from '../src/transcript-reader.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prtokens-transcripts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readClaudeTranscripts', () => {
  it('reads usage events from Claude JSONL transcripts with diagnostics', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/samuelzhang/Documents/GitHub/prtokens';
    const normalizedRepo = repoRoot.replaceAll('/', '-');
    const projectDir = join(homeDir, '.claude', 'projects', normalizedRepo);
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'session.jsonl'),
      [
        '{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","costUSD":0.1234,"message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":20}},"gitBranch":"feature"}',
        '{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10}},"gitBranch":"feature"}',
        '{"sessionId":"s2","timestamp":"2026-06-12T10:05:00.000Z","message":{"id":"m2","model":"claude-opus-4-8","sidechains":[{"usage":{"input_tokens":50,"output_tokens":5}}]},"gitBranch":"main"}',
        'not json',
      ].join('\n'),
    );

    const result = await readClaudeTranscripts({ repoRoot, homeDir });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      agent: 'claude-code',
      inputTokens: 100,
      outputTokens: 10,
      cacheWriteTokens: 5,
      cacheReadTokens: 20,
      sourceCostUsd: 0.1234,
      gitBranch: 'feature',
    });
    expect(result.events[1]).toMatchObject({
      inputTokens: 50,
      outputTokens: 5,
      gitBranch: 'main',
    });
    expect(result.diagnostics.malformedLineCount).toBe(1);
    expect(result.diagnostics.dedupedEventCount).toBe(1);
  });

  it('falls back to all project transcripts and requires explicit matching repo metadata', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/samuelzhang/Documents/GitHub/prtokens';
    const otherRepoRoot = '/Users/samuelzhang/Documents/GitHub/other';
    const projectDir = join(homeDir, '.claude', 'projects', 'unmatched-project');
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'session.jsonl'),
      [
        `{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","cwd":"${repoRoot}","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10}}}`,
        `{"sessionId":"s2","timestamp":"2026-06-12T10:05:00.000Z","requestId":"r2","repoRoot":"${otherRepoRoot}","message":{"id":"m2","model":"claude-opus-4-8","usage":{"input_tokens":200,"output_tokens":20}}}`,
        '{"sessionId":"s3","timestamp":"2026-06-12T10:10:00.000Z","requestId":"r3","message":{"id":"m3","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":30}}}',
      ].join('\n'),
    );

    const result = await readClaudeTranscripts({ repoRoot, homeDir });

    expect(result.events).toHaveLength(1);
    expect(result.events.map((event) => event.inputTokens)).toEqual([100]);
    expect(result.diagnostics.skippedLineCount).toBe(2);
  });

  it('does not read metadata-less fallback events from a prefix-colliding project directory', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const otherRepoRoot = '/Users/me/repo-copy';
    const projectDir = join(homeDir, '.claude', 'projects', otherRepoRoot.replaceAll('/', '-'));
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'session.jsonl'),
      '{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10}}}',
    );

    const result = await readClaudeTranscripts({ repoRoot, homeDir });

    expect(result.events).toHaveLength(0);
    expect(result.diagnostics.skippedLineCount).toBe(1);
  });

  it('excludes repo-field mismatches from prefix-colliding project directories', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const otherRepoRoot = '/Users/me/repo-copy';
    const projectsDir = join(homeDir, '.claude', 'projects');
    const projectDir = join(projectsDir, repoRoot.replaceAll('/', '-'));
    const collidingProjectDir = join(projectsDir, otherRepoRoot.replaceAll('/', '-'));
    await mkdir(projectDir, { recursive: true });
    await mkdir(collidingProjectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'session.jsonl'),
      `{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","cwd":"${repoRoot}","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10}}}`,
    );
    await writeFile(
      join(collidingProjectDir, 'session.jsonl'),
      `{"sessionId":"s2","timestamp":"2026-06-12T10:05:00.000Z","requestId":"r2","repoRoot":"${otherRepoRoot}","message":{"id":"m2","model":"claude-opus-4-8","usage":{"input_tokens":200,"output_tokens":20}}}`,
    );

    const result = await readClaudeTranscripts({ repoRoot, homeDir });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ inputTokens: 100, sessionId: 's1' });
    expect(result.diagnostics.skippedLineCount).toBe(0);
  });

  it('does not read metadata-less events from prefix-colliding project directories', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const otherRepoRoot = '/Users/me/repo-copy';
    const projectsDir = join(homeDir, '.claude', 'projects');
    const projectDir = join(projectsDir, repoRoot.replaceAll('/', '-'));
    const collidingProjectDir = join(projectsDir, otherRepoRoot.replaceAll('/', '-'));
    await mkdir(projectDir, { recursive: true });
    await mkdir(collidingProjectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'session.jsonl'),
      '{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10}}}',
    );
    await writeFile(
      join(collidingProjectDir, 'session.jsonl'),
      '{"sessionId":"s2","timestamp":"2026-06-12T10:05:00.000Z","requestId":"r2","message":{"id":"m2","model":"claude-opus-4-8","usage":{"input_tokens":200,"output_tokens":20}}}',
    );

    const result = await readClaudeTranscripts({ repoRoot, homeDir });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ inputTokens: 100, sessionId: 's1' });
  });

  it('dedupes repeated nested sidechain usage by stable nested identity', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/samuelzhang/Documents/GitHub/prtokens';
    const normalizedRepo = repoRoot.replaceAll('/', '-');
    const projectDir = join(homeDir, '.claude', 'projects', normalizedRepo);
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'session.jsonl'),
      [
        '{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","message":{"id":"parent-1","model":"claude-sonnet-4-6","sidechains":[{"requestId":"nested-r1","message":{"id":"nested-m1","model":"claude-opus-4-8","usage":{"input_tokens":50,"output_tokens":5}}}]} }',
        '{"sessionId":"s1","timestamp":"2026-06-12T10:01:00.000Z","message":{"id":"parent-2","model":"claude-sonnet-4-6","subagents":[{"usage":{"input_tokens":1,"output_tokens":1}},{"requestId":"nested-r1","message":{"id":"nested-m1","model":"claude-opus-4-8","usage":{"input_tokens":50,"output_tokens":5}}}]} }',
      ].join('\n'),
    );

    const result = await readClaudeTranscripts({ repoRoot, homeDir });

    expect(result.events).toHaveLength(2);
    expect(result.events.filter((event) => event.inputTokens === 50)).toHaveLength(1);
    expect(result.diagnostics.dedupedEventCount).toBe(1);
  });
});
