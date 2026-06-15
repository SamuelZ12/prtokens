import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { ReadTranscriptsInput, TranscriptDiagnostics } from './transcript-reader.js';
import type { UsageEvent } from './types.js';

const require = createRequire(import.meta.url);

export interface DatabaseLike {
  prepare(sql: string): {
    all(...anonymousParameters: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}

export interface SqliteModule {
  DatabaseSync: new (dbFile: string, options?: { readOnly?: boolean }) => DatabaseLike;
}

export type OpencodeDiagnostics = TranscriptDiagnostics & { warningMessages: string[] };

export interface ReadOpencodeInput extends ReadTranscriptsInput {
  sqliteLoader?: () => Promise<SqliteModule>;
}

export interface ReadOpencodeResult {
  events: UsageEvent[];
  diagnostics: OpencodeDiagnostics;
}

export async function readOpencodeUsage(input: ReadOpencodeInput): Promise<ReadOpencodeResult> {
  const repoRoots = uniqueRepoRoots([input.repoRoot, ...(input.repoRootAliases ?? [])]);
  const dataDir = path.join(input.homeDir ?? os.homedir(), '.local', 'share', 'opencode');
  const dbFiles = await findOpencodeDatabases(dataDir);
  const diagnostics: OpencodeDiagnostics = {
    scannedFileCount: dbFiles.length,
    malformedLineCount: 0,
    dedupedEventCount: 0,
    skippedLineCount: 0,
    warningMessages: [],
  };
  const events: UsageEvent[] = [];
  const seenIds = new Set<string>();

  if (dbFiles.length === 0) {
    return { events, diagnostics };
  }

  let sqlite: SqliteModule;
  try {
    sqlite = await (input.sqliteLoader ?? loadSqlite)();
  } catch (error) {
    diagnostics.warningMessages.push(`OpenCode skipped: ${errorMessage(error)}`);
    return { events, diagnostics };
  }

  for (const dbFile of dbFiles) {
    const candidates = readDatabase(sqlite, dbFile, repoRoots, diagnostics);
    for (const event of candidates) {
      if (seenIds.has(event.id)) {
        diagnostics.dedupedEventCount += 1;
        continue;
      }
      seenIds.add(event.id);
      events.push(event);
    }
  }

  return { events, diagnostics };
}

async function loadSqlite(): Promise<SqliteModule> {
  const sqliteModule = 'node:sqlite';
  try {
    return (await import(sqliteModule)) as unknown as SqliteModule;
  } catch {
    return require(sqliteModule) as SqliteModule;
  }
}

async function findOpencodeDatabases(dataDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && (entry.name === 'opencode.db' || /^opencode-.+\.db$/.test(entry.name)))
    .map((entry) => path.join(dataDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function readDatabase(
  sqlite: SqliteModule,
  dbFile: string,
  repoRoots: string[],
  diagnostics: OpencodeDiagnostics,
): UsageEvent[] {
  let db: DatabaseLike | undefined;
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    const malformedCount = readMalformedCount(db);
    diagnostics.malformedLineCount += malformedCount;
    diagnostics.skippedLineCount += malformedCount;
    const rows = readUsageRows(db, repoRoots);
    const parentSessionIds = readSessionParentIds(db);
    const events: UsageEvent[] = [];

    for (const row of rows) {
      const event = rowToUsageEvent(row, parentSessionIds);
      if (!event) {
        diagnostics.skippedLineCount += 1;
        continue;
      }
      events.push(event);
    }

    return events;
  } catch (error) {
    diagnostics.warningMessages.push(`OpenCode skipped ${dbFile}: ${errorMessage(error)}`);
    return [];
  } finally {
    db?.close();
  }
}

function readMalformedCount(db: DatabaseLike): number {
  const rows = db.prepare('SELECT COUNT(*) AS count FROM message WHERE NOT json_valid(data)').all();
  return getNumber(rows[0]?.count) ?? 0;
}

function readUsageRows(db: DatabaseLike, repoRoots: string[]): Record<string, unknown>[] {
  const placeholders = repoRoots.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT
        id,
        session_id AS sessionId,
        json_extract(data, '$.modelID') AS model,
        json_extract(data, '$.time.completed') AS completedAt,
        json_extract(data, '$.time.created') AS createdAt,
        json_extract(data, '$.tokens.input') AS inputTokens,
        json_extract(data, '$.tokens.output') AS outputTokens,
        json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
        json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
        json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens
      FROM message
      WHERE json_valid(data)
        AND json_extract(data, '$.role') = 'assistant'
        AND json_extract(data, '$.path.root') IN (${placeholders})
      ORDER BY COALESCE(json_extract(data, '$.time.completed'), json_extract(data, '$.time.created'), time_created), id`,
    )
    .all(...repoRoots);
}

function readSessionParentIds(db: DatabaseLike): Map<string, string | undefined> {
  try {
    const rows = db.prepare('SELECT id, parent_id AS parentId FROM session').all();
    const parents = new Map<string, string | undefined>();
    for (const row of rows) {
      const id = getString(row.id);
      if (!id) {
        continue;
      }
      parents.set(id, getString(row.parentId));
    }
    return parents;
  } catch (error) {
    const message = errorMessage(error).toLowerCase();
    if (message.includes('no such table') || (message.includes('no such column') && message.includes('parent_id'))) {
      return new Map();
    }
    throw error;
  }
}

function uniqueRepoRoots(repoRoots: string[]): string[] {
  return [...new Set(repoRoots.map((repoRoot) => path.resolve(repoRoot)))];
}

function rowToUsageEvent(row: Record<string, unknown>, parentSessionIds: Map<string, string | undefined>): UsageEvent | undefined {
  const id = getString(row.id);
  const sessionId = getString(row.sessionId);
  if (!id || !sessionId) {
    return undefined;
  }

  return {
    id: `opencode-db:${id}`,
    agent: 'opencode',
    timestamp: toIsoTimestamp(getNumber(row.completedAt) ?? getNumber(row.createdAt)),
    model: getString(row.model) ?? '',
    inputTokens: getNumber(row.inputTokens) ?? 0,
    outputTokens: (getNumber(row.outputTokens) ?? 0) + (getNumber(row.reasoningTokens) ?? 0),
    cacheWriteTokens: getNumber(row.cacheWriteTokens) ?? 0,
    cacheReadTokens: getNumber(row.cacheReadTokens) ?? 0,
    sessionId: rootSessionId(sessionId, parentSessionIds),
  };
}

function rootSessionId(sessionId: string, parentSessionIds: Map<string, string | undefined>): string {
  let current = sessionId;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(current)) {
      return sessionId;
    }
    visited.add(current);

    const parent = parentSessionIds.get(current);
    if (parent === undefined) {
      return parentSessionIds.has(current) ? current : sessionId;
    }
    if (!parentSessionIds.has(parent)) {
      return sessionId;
    }

    current = parent;
  }
}

function toIsoTimestamp(epochMs: number | undefined): string {
  if (epochMs === undefined) {
    return '';
  }
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
