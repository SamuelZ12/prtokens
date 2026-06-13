import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOpencodeUsage } from '../src/opencode-reader.js';

const tempDirs: string[] = [];
const require = createRequire(import.meta.url);

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prtokens-opencode-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readOpencodeUsage', () => {
  it('reads assistant message token usage for the matching repo root', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/samuelzhang/Documents/GitHub/prtokens';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(join(dataDir, 'opencode.db'), [
      messageRow('m1', 's1', {
        role: 'assistant',
        path: { root: repoRoot },
        modelID: 'gpt-5.5-fast',
        time: { created: Date.parse('2024-06-12T11:00:00.000Z'), completed: Date.parse('2024-06-12T11:00:01.000Z') },
        tokens: { input: 100, output: 25, reasoning: 2, cache: { read: 30, write: 4 } },
      }),
    ]);

    const result = await readOpencodeUsage({ repoRoot, homeDir });

    expect(result.events).toEqual([
      {
        id: 'opencode-db:m1',
        agent: 'opencode',
        timestamp: '2024-06-12T11:00:01.000Z',
        model: 'gpt-5.5-fast',
        inputTokens: 100,
        outputTokens: 27,
        cacheReadTokens: 30,
        cacheWriteTokens: 4,
        sessionId: 's1',
      },
    ]);
    expect(result.diagnostics).toEqual({
      scannedFileCount: 1,
      malformedLineCount: 0,
      dedupedEventCount: 0,
      skippedLineCount: 0,
      warningMessages: [],
    });
  });

  it('filters non-assistant rows and other repo roots', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(join(dataDir, 'opencode.db'), [
      messageRow('user-1', 's1', { role: 'user', path: { root: repoRoot }, tokens: { input: 999 } }),
      messageRow('other-1', 's2', {
        role: 'assistant',
        path: { root: '/Users/me/other' },
        modelID: 'gpt-5.5-fast',
        time: { completed: Date.parse('2024-06-12T11:00:00.000Z') },
        tokens: { input: 999, output: 999 },
      }),
      messageRow('match-1', 's3', {
        role: 'assistant',
        path: { root: repoRoot },
        modelID: 'gpt-5.5-fast',
        time: { completed: Date.parse('2024-06-12T11:01:00.000Z') },
        tokens: { input: 10, output: 2 },
      }),
    ]);

    const result = await readOpencodeUsage({ repoRoot, homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: 'opencode-db:match-1', inputTokens: 10, outputTokens: 2, sessionId: 's3' });
  });

  it('dedupes migrated messages across sibling databases', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    const rows = [
      messageRow('migrated-1', 's1', {
        role: 'assistant',
        path: { root: repoRoot },
        modelID: 'gpt-5.5-fast',
        time: { completed: Date.parse('2024-06-12T11:00:00.000Z') },
        tokens: { input: 10, output: 1 },
      }),
    ];
    await createMessageDatabase(join(dataDir, 'opencode.db'), rows);
    await createMessageDatabase(join(dataDir, 'opencode-archive.db'), rows);

    const result = await readOpencodeUsage({ repoRoot, homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe('opencode-db:migrated-1');
    expect(result.diagnostics.scannedFileCount).toBe(2);
    expect(result.diagnostics.dedupedEventCount).toBe(1);
  });

  it('tallies malformed JSON message data without failing valid rows', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(join(dataDir, 'opencode.db'), [
      { id: 'bad-1', sessionId: 's1', data: '{not json' },
      messageRow('valid-1', 's1', {
        role: 'assistant',
        path: { root: repoRoot },
        modelID: 'gpt-5.5-fast',
        time: { created: Date.parse('2024-06-12T11:00:00.000Z') },
        tokens: { input: 3, output: 4, reasoning: 5 },
      }),
    ]);

    const result = await readOpencodeUsage({ repoRoot, homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: 'opencode-db:valid-1', outputTokens: 9 });
    expect(result.diagnostics.malformedLineCount).toBe(1);
    expect(result.diagnostics.skippedLineCount).toBe(1);
  });

  it('is silent when the OpenCode data directory is missing', async () => {
    const homeDir = await createTempDir();

    const result = await readOpencodeUsage({ repoRoot: '/Users/me/repo', homeDir });

    expect(result.events).toEqual([]);
    expect(result.diagnostics).toEqual({
      scannedFileCount: 0,
      malformedLineCount: 0,
      dedupedEventCount: 0,
      skippedLineCount: 0,
      warningMessages: [],
    });
  });

  it('returns a warning diagnostic when sqlite cannot be loaded', async () => {
    const homeDir = await createTempDir();
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(join(dataDir, 'opencode.db'), []);

    const result = await readOpencodeUsage({
      repoRoot: '/Users/me/repo',
      homeDir,
      sqliteLoader: async () => {
        throw new Error('node:sqlite unavailable');
      },
    });

    expect(result.events).toEqual([]);
    expect(result.diagnostics.warningMessages).toEqual(['OpenCode skipped: node:sqlite unavailable']);
  });
});

interface MessageRow {
  id: string;
  sessionId: string;
  data: string;
}

async function createOpencodeDataDir(homeDir: string): Promise<string> {
  const dataDir = join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

async function createMessageDatabase(dbFile: string, rows: MessageRow[]): Promise<void> {
  const { DatabaseSync } = await loadSqliteFixture();
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.sessionId, 0, row.data);
  }
  db.close();
}

function messageRow(id: string, sessionId: string, data: Record<string, unknown>): MessageRow {
  return { id, sessionId, data: JSON.stringify(data) };
}

async function loadSqliteFixture(): Promise<SqliteFixtureModule> {
  return require('node:sqlite') as SqliteFixtureModule;
}

interface SqliteFixtureModule {
  DatabaseSync: new (dbFile: string, options?: { readOnly?: boolean }) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...anonymousParameters: unknown[]): Record<string, unknown>[];
      run(...anonymousParameters: unknown[]): void;
    };
    close(): void;
  };
}
