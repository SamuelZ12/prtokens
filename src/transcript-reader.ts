import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UsageEvent } from './types.js';

export interface ReadTranscriptsInput {
  repoRoot: string;
  homeDir?: string;
}

export interface TranscriptDiagnostics {
  scannedFileCount: number;
  malformedLineCount: number;
  dedupedEventCount: number;
  skippedLineCount: number;
}

export interface ReadTranscriptsResult {
  events: UsageEvent[];
  diagnostics: TranscriptDiagnostics;
}

interface UsageCandidate {
  event: UsageEvent;
  dedupeKey: string;
}

interface ParentContext {
  sessionId?: string;
  timestamp?: string;
  requestId?: string;
  messageId?: string;
  model?: string;
  gitBranch?: string;
}

type JsonObject = Record<string, unknown>;

const sidechainKeys = new Set(['sidechains', 'sideChains', 'subagents']);

export async function readClaudeTranscripts(input: ReadTranscriptsInput): Promise<ReadTranscriptsResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const projectsDir = path.join(input.homeDir ?? os.homedir(), '.claude', 'projects');
  const allJsonlFiles = await findJsonlFiles(projectsDir);
  const normalizedRepo = normalizeRepoName(repoRoot);
  const matchingFiles = allJsonlFiles.filter((filePath) => {
    const projectPath = path.relative(projectsDir, path.dirname(filePath));
    return normalizeRepoName(projectPath).includes(normalizedRepo);
  });
  const transcriptFiles = matchingFiles.length > 0 ? matchingFiles : allJsonlFiles;
  const shouldFilterByRepoFields = matchingFiles.length === 0;

  const diagnostics: TranscriptDiagnostics = {
    scannedFileCount: transcriptFiles.length,
    malformedLineCount: 0,
    dedupedEventCount: 0,
    skippedLineCount: 0,
  };
  const events: UsageEvent[] = [];
  const seenDedupeKeys = new Set<string>();

  for (const filePath of transcriptFiles) {
    const contents = await readFile(filePath, 'utf8');
    const lines = contents.split(/\r?\n/);
    for (const [index, rawLine] of lines.entries()) {
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

      if (shouldFilterByRepoFields && !matchesRepoWhenPresent(line, repoRoot)) {
        diagnostics.skippedLineCount += 1;
        continue;
      }

      const candidates = collectUsageCandidates(line, filePath, index + 1);
      if (candidates.length === 0) {
        diagnostics.skippedLineCount += 1;
        continue;
      }

      for (const candidate of candidates) {
        if (seenDedupeKeys.has(candidate.dedupeKey)) {
          diagnostics.dedupedEventCount += 1;
          continue;
        }
        seenDedupeKeys.add(candidate.dedupeKey);
        events.push(candidate.event);
      }
    }
  }

  return { events, diagnostics };
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJsonlFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectUsageCandidates(line: JsonObject, filePath: string, lineNumber: number): UsageCandidate[] {
  const message = getObject(line.message);
  const parentContext: ParentContext = {
    sessionId: getString(line.sessionId),
    timestamp: getString(line.timestamp),
    requestId: getString(line.requestId),
    messageId: getString(message?.id),
    model: getString(message?.model) ?? getString(line.model),
    gitBranch: getString(line.gitBranch) ?? getString(line.git_branch),
  };
  const candidates: UsageCandidate[] = [];
  const rootUsage = getObject(message?.usage) ?? getObject(line.usage);

  if (rootUsage) {
    const candidate = createUsageCandidate(rootUsage, line, parentContext, filePath, lineNumber);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  collectNestedUsageCandidates(line, parentContext, filePath, lineNumber, [], candidates);
  return candidates;
}

function collectNestedUsageCandidates(
  value: unknown,
  parentContext: ParentContext,
  filePath: string,
  lineNumber: number,
  pathParts: string[],
  candidates: UsageCandidate[],
): void {
  if (!isObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (sidechainKeys.has(key) && Array.isArray(child)) {
      child.forEach((item, index) => {
        const nestedPath = [...pathParts, `${key}[${index}]`];
        if (isObject(item)) {
          const nestedUsage = getObject(item.usage) ?? getObject(getObject(item.message)?.usage);
          if (nestedUsage) {
            const candidate = createUsageCandidate(nestedUsage, item, parentContext, filePath, lineNumber, nestedPath);
            if (candidate) {
              candidates.push(candidate);
            }
          }
          collectNestedUsageCandidates(item, mergeContext(parentContext, item), filePath, lineNumber, nestedPath, candidates);
        }
      });
    } else if (isObject(child)) {
      collectNestedUsageCandidates(child, parentContext, filePath, lineNumber, [...pathParts, key], candidates);
    }
  }
}

function createUsageCandidate(
  usage: JsonObject,
  source: JsonObject,
  parentContext: ParentContext,
  filePath: string,
  lineNumber: number,
  nestedPath: string[] = [],
): UsageCandidate | undefined {
  const tokenTotals = mapUsage(usage);
  if (!tokenTotals) {
    return undefined;
  }

  const context = mergeContext(parentContext, source);
  const fallbackKey = `${filePath}:${lineNumber}`;
  const nestedSuffix = nestedPath.length > 0 ? `:${nestedPath.join('.')}` : '';
  const hasOwnIdentity = typeof context.messageId === 'string' && typeof context.requestId === 'string';
  const dedupeKey = hasOwnIdentity
    ? `${context.messageId}:${context.requestId}${nestedSuffix}`
    : `${fallbackKey}${nestedSuffix}`;

  return {
    dedupeKey,
    event: {
      id: `claude-transcript:${dedupeKey}`,
      timestamp: context.timestamp ?? '',
      model: context.model ?? '',
      inputTokens: tokenTotals.inputTokens,
      outputTokens: tokenTotals.outputTokens,
      cacheWriteTokens: tokenTotals.cacheWriteTokens,
      cacheReadTokens: tokenTotals.cacheReadTokens,
      sessionId: context.sessionId ?? '',
      gitBranch: context.gitBranch,
    },
  };
}

function mergeContext(parentContext: ParentContext, source: JsonObject): ParentContext {
  const message = getObject(source.message);
  return {
    sessionId: getString(source.sessionId) ?? parentContext.sessionId,
    timestamp: getString(source.timestamp) ?? parentContext.timestamp,
    requestId: getString(source.requestId) ?? parentContext.requestId,
    messageId: getString(message?.id) ?? getString(source.id) ?? parentContext.messageId,
    model: getString(message?.model) ?? getString(source.model) ?? parentContext.model,
    gitBranch: getString(source.gitBranch) ?? getString(source.git_branch) ?? parentContext.gitBranch,
  };
}

function mapUsage(usage: JsonObject): Omit<UsageEvent, 'id' | 'timestamp' | 'model' | 'sessionId' | 'gitBranch'> | undefined {
  const inputTokens = getNumber(usage.input_tokens) ?? 0;
  const outputTokens = getNumber(usage.output_tokens) ?? 0;
  const cacheWriteTokens = getNumber(usage.cache_creation_input_tokens) ?? 0;
  const cacheReadTokens = getNumber(usage.cache_read_input_tokens) ?? 0;
  const hasUsableValue = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].some((value) => getNumber(value) !== undefined);

  if (!hasUsableValue) {
    return undefined;
  }

  return { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens };
}

function matchesRepoWhenPresent(line: JsonObject, repoRoot: string): boolean {
  const cwd = getString(line.cwd);
  const lineRepoRoot = getString(line.repoRoot);
  if (cwd === undefined && lineRepoRoot === undefined) {
    return true;
  }
  return cwd === repoRoot || lineRepoRoot === repoRoot;
}

function normalizeRepoName(value: string): string {
  return value.replace(/[\\/]+/g, '-');
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
