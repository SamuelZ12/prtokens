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

  it('reads usage recorded under a sibling worktree root alias', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo/.worktrees/feature';
    const mainWorktreeRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(join(dataDir, 'opencode.db'), [
      messageRow('alias-1', 's1', {
        role: 'assistant',
        path: { root: mainWorktreeRoot },
        modelID: 'gpt-5.5-fast',
        time: { completed: Date.parse('2024-06-12T11:01:00.000Z') },
        tokens: { input: 10, output: 2 },
      }),
    ]);

    const result = await readOpencodeUsage({ repoRoot, repoRootAliases: [mainWorktreeRoot], homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: 'opencode-db:alias-1', inputTokens: 10, outputTokens: 2, sessionId: 's1' });
  });

  it('groups child and nested OpenCode sessions under their root session', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(
      join(dataDir, 'opencode.db'),
      [
        messageRow('root-message', 'root-session', {
          role: 'assistant',
          path: { root: repoRoot },
          modelID: 'gpt-5.5-fast',
          time: { completed: Date.parse('2024-06-12T11:00:00.000Z') },
          tokens: { input: 10, output: 1 },
        }),
        messageRow('child-message', 'child-session', {
          role: 'assistant',
          path: { root: repoRoot },
          modelID: 'gpt-5.5-fast',
          time: { completed: Date.parse('2024-06-12T11:01:00.000Z') },
          tokens: { input: 20, output: 2 },
        }),
        messageRow('nested-child-message', 'nested-child-session', {
          role: 'assistant',
          path: { root: repoRoot },
          modelID: 'gpt-5.5-fast',
          time: { completed: Date.parse('2024-06-12T11:02:00.000Z') },
          tokens: { input: 30, output: 3 },
        }),
      ],
      [
        sessionRow('root-session'),
        sessionRow('child-session', 'root-session'),
        sessionRow('nested-child-session', 'child-session'),
      ],
    );

    const result = await readOpencodeUsage({ repoRoot, homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events.map((event) => event.sessionId)).toEqual(['root-session', 'root-session', 'root-session']);
  });

  it('keeps the raw session id when OpenCode parent session metadata is missing', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(
      join(dataDir, 'opencode.db'),
      [
        messageRow('orphan-message', 'orphan-child-session', {
          role: 'assistant',
          path: { root: repoRoot },
          modelID: 'gpt-5.5-fast',
          time: { completed: Date.parse('2024-06-12T11:00:00.000Z') },
          tokens: { input: 10, output: 1 },
        }),
      ],
      [sessionRow('orphan-child-session', 'missing-parent-session')],
    );

    const result = await readOpencodeUsage({ repoRoot, homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events[0]).toMatchObject({ sessionId: 'orphan-child-session' });
  });

  it('keeps usage when the OpenCode session table has no parent_id column', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabaseWithoutSessionParentId(join(dataDir, 'opencode.db'), [
      messageRow('old-schema-message', 'raw-session', {
        role: 'assistant',
        path: { root: repoRoot },
        modelID: 'gpt-5.5-fast',
        time: { completed: Date.parse('2024-06-12T11:00:00.000Z') },
        tokens: { input: 10, output: 1 },
      }),
    ]);

    const result = await readOpencodeUsage({ repoRoot, homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: 'opencode-db:old-schema-message', sessionId: 'raw-session' });
    expect(result.diagnostics.warningMessages).toEqual([]);
  });

  it('keeps raw session ids when OpenCode parent session metadata is cyclic', async () => {
    const homeDir = await createTempDir();
    const repoRoot = '/Users/me/repo';
    const dataDir = await createOpencodeDataDir(homeDir);
    await createMessageDatabase(
      join(dataDir, 'opencode.db'),
      [
        messageRow('a-message', 'a-session', {
          role: 'assistant',
          path: { root: repoRoot },
          modelID: 'gpt-5.5-fast',
          time: { completed: Date.parse('2024-06-12T11:00:00.000Z') },
          tokens: { input: 10, output: 1 },
        }),
        messageRow('b-message', 'b-session', {
          role: 'assistant',
          path: { root: repoRoot },
          modelID: 'gpt-5.5-fast',
          time: { completed: Date.parse('2024-06-12T11:01:00.000Z') },
          tokens: { input: 20, output: 2 },
        }),
      ],
      [sessionRow('a-session', 'b-session'), sessionRow('b-session', 'a-session')],
    );

    const result = await readOpencodeUsage({ repoRoot, homeDir, sqliteLoader: loadSqliteFixture });

    expect(result.events.map((event) => event.sessionId)).toEqual(['a-session', 'b-session']);
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

interface SessionRow {
  id: string;
  parentId?: string;
}

async function createOpencodeDataDir(homeDir: string): Promise<string> {
  const dataDir = join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

async function createMessageDatabase(dbFile: string, rows: MessageRow[], sessions: SessionRow[] = []): Promise<void> {
  const { DatabaseSync } = await loadSqliteFixture();
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL)');
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT)');
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.sessionId, 0, row.data);
  }
  const insertSession = db.prepare('INSERT INTO session (id, parent_id) VALUES (?, ?)');
  for (const session of sessions) {
    insertSession.run(session.id, session.parentId ?? null);
  }
  db.close();
}

async function createMessageDatabaseWithoutSessionParentId(dbFile: string, rows: MessageRow[]): Promise<void> {
  const { DatabaseSync } = await loadSqliteFixture();
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL)');
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.sessionId, 0, row.data);
  }
  db.close();
}

function messageRow(id: string, sessionId: string, data: Record<string, unknown>): MessageRow {
  return { id, sessionId, data: JSON.stringify(data) };
}

function sessionRow(id: string, parentId?: string): SessionRow {
  return { id, parentId };
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
