import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ReadTranscriptsInput, ReadTranscriptsResult, TranscriptDiagnostics } from './transcript-reader.js';
import type { UsageEvent } from './types.js';

type JsonObject = Record<string, unknown>;

interface RolloutFile {
  path: string;
  relativePath: string;
}

interface SessionMeta {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
}

interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface UsageCandidate {
  event: UsageEvent;
  dedupeKey: string;
}

export async function readCodexUsage(input: ReadTranscriptsInput): Promise<ReadTranscriptsResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const homeDir = input.homeDir ?? os.homedir();
  const files = await codexFilesWithActivePrecedence(homeDir);
  const diagnostics: TranscriptDiagnostics = {
    scannedFileCount: files.length,
    malformedLineCount: 0,
    dedupedEventCount: 0,
    skippedLineCount: 0,
  };
  const events: UsageEvent[] = [];
  const seenDedupeKeys = new Set<string>();

  for (const file of files) {
    const candidates = await readRolloutFile(file, repoRoot, diagnostics);
    for (const candidate of candidates) {
      if (seenDedupeKeys.has(candidate.dedupeKey)) {
        diagnostics.dedupedEventCount += 1;
        continue;
      }
      seenDedupeKeys.add(candidate.dedupeKey);
      events.push(candidate.event);
    }
  }

  return { events, diagnostics };
}

async function codexFilesWithActivePrecedence(homeDir: string): Promise<RolloutFile[]> {
  const activeRoot = path.join(homeDir, '.codex', 'sessions');
  const archivedRoot = path.join(homeDir, '.codex', 'archived_sessions');
  const activeFiles = await findJsonlFiles(activeRoot);
  const archivedFiles = await findJsonlFiles(archivedRoot);
  const selectedFiles = new Map<string, RolloutFile>();

  for (const file of archivedFiles) {
    selectedFiles.set(file.relativePath, file);
  }
  for (const file of activeFiles) {
    selectedFiles.set(file.relativePath, file);
  }

  return Array.from(selectedFiles.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function findJsonlFiles(dir: string, rootDir = dir): Promise<RolloutFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: RolloutFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJsonlFiles(entryPath, rootDir)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push({ path: entryPath, relativePath: path.relative(rootDir, entryPath) });
    }
  }
  return files;
}

async function readRolloutFile(
  file: RolloutFile,
  repoRoot: string,
  diagnostics: TranscriptDiagnostics,
): Promise<UsageCandidate[]> {
  const candidates: UsageCandidate[] = [];
  const rl = createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let sessionMeta: SessionMeta | undefined;
  let model = '';
  let previousTotalUsage: CodexTokenUsage | undefined;

  for await (const rawLine of rl) {
    if (rawLine.trim() === '') {
      continue;
    }

    let line: unknown;
    try {
      line = JSON.parse(rawLine);
    } catch {
      diagnostics.malformedLineCount += 1;
      continue;
    }

    if (!isObject(line)) {
      diagnostics.skippedLineCount += 1;
      continue;
    }

    const lineType = getString(line.type);
    const payload = getObject(line.payload);
    if (lineType === 'session_meta') {
      sessionMeta = parseSessionMeta(payload);
      if (!sessionMeta) {
        diagnostics.skippedLineCount += 1;
      }
      continue;
    }

    if (lineType === 'turn_context') {
      const nextModel = getString(payload?.model);
      if (nextModel) {
        model = nextModel;
      }
      continue;
    }

    if (lineType !== 'event_msg' || payload?.type !== 'token_count') {
      continue;
    }

    const tokenInfo = getObject(payload.info);
    if (!sessionMeta || path.resolve(sessionMeta.cwd) !== repoRoot || !tokenInfo) {
      diagnostics.skippedLineCount += 1;
      continue;
    }

    const totalUsage = tokenUsageFromInfo(tokenInfo, 'total_token_usage');
    const lastUsage = tokenUsageFromInfo(tokenInfo, 'last_token_usage');
    const deltaUsage = lastUsage ?? (totalUsage ? subtractTokenUsage(totalUsage, previousTotalUsage) : undefined);
    if (totalUsage) {
      previousTotalUsage = totalUsage;
    }
    if (!deltaUsage) {
      diagnostics.skippedLineCount += 1;
      continue;
    }

    const normalizedUsage = normalizeTokenUsage(deltaUsage);
    const timestamp = getString(line.timestamp) ?? '';
    const totalTokens = (totalUsage ?? deltaUsage).totalTokens;
    const dedupeKey = sessionMeta.sessionId && timestamp
      ? `${sessionMeta.sessionId}:${timestamp}:${totalTokens}`
      : `${file.path}:${candidates.length}`;

    candidates.push({
      dedupeKey,
      event: {
        id: `codex-rollout:${dedupeKey}`,
        agent: 'codex',
        timestamp,
        model,
        inputTokens: normalizedUsage.inputTokens,
        outputTokens: normalizedUsage.outputTokens,
        cacheWriteTokens: 0,
        cacheReadTokens: normalizedUsage.cacheReadTokens,
        sessionId: sessionMeta.sessionId,
        gitBranch: sessionMeta.gitBranch,
      },
    });
  }

  return candidates;
}

function parseSessionMeta(payload: JsonObject | undefined): SessionMeta | undefined {
  if (!payload) {
    return undefined;
  }

  const sessionId = getString(payload.id);
  const cwd = getString(payload.cwd);
  if (!sessionId || !cwd) {
    return undefined;
  }

  return {
    sessionId,
    cwd,
    gitBranch: getString(getObject(payload.git)?.branch),
  };
}

function tokenUsageFromInfo(info: JsonObject, key: 'last_token_usage' | 'total_token_usage'): CodexTokenUsage | undefined {
  const usage = getObject(info[key]);
  if (!usage) {
    return undefined;
  }

  const inputTokens = getNumber(usage.input_tokens);
  const cachedInputTokens = getNumber(usage.cached_input_tokens) ?? getNumber(usage.cache_read_input_tokens);
  const outputTokens = getNumber(usage.output_tokens);
  const totalTokens = getNumber(usage.total_tokens);
  const hasUsableValue = [inputTokens, cachedInputTokens, outputTokens, totalTokens].some((value) => value !== undefined);
  if (!hasUsableValue) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function subtractTokenUsage(current: CodexTokenUsage, previous: CodexTokenUsage | undefined): CodexTokenUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - (previous?.inputTokens ?? 0)),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - (previous?.cachedInputTokens ?? 0)),
    outputTokens: Math.max(0, current.outputTokens - (previous?.outputTokens ?? 0)),
    totalTokens: current.totalTokens,
  };
}

function normalizeTokenUsage(
  usage: CodexTokenUsage,
): Omit<UsageEvent, 'id' | 'agent' | 'timestamp' | 'model' | 'sessionId' | 'gitBranch'> {
  const cacheReadTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return {
    inputTokens: Math.max(0, usage.inputTokens - cacheReadTokens),
    outputTokens: usage.outputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens,
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
