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
    const projectDir = join(homeDir, '.claude', 'projects', `project-${normalizedRepo}`);
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'session.jsonl'),
      [
        '{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":20}},"gitBranch":"feature"}',
        '{"sessionId":"s1","timestamp":"2026-06-12T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":10}},"gitBranch":"feature"}',
        '{"sessionId":"s2","timestamp":"2026-06-12T10:05:00.000Z","message":{"id":"m2","model":"claude-opus-4-8","sidechains":[{"usage":{"input_tokens":50,"output_tokens":5}}]},"gitBranch":"main"}',
        'not json',
      ].join('\n'),
    );

    const result = await readClaudeTranscripts({ repoRoot, homeDir });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      cacheWriteTokens: 5,
      cacheReadTokens: 20,
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
});
