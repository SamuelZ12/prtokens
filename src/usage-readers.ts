import { readCodexUsage } from './codex-reader.js';
import { readOpencodeUsage } from './opencode-reader.js';
import { readClaudeTranscripts, type ReadTranscriptsInput, type TranscriptDiagnostics } from './transcript-reader.js';
import type { AgentName, UsageEvent } from './types.js';

export type UsageSourceDiagnostics = TranscriptDiagnostics & { warningMessages: string[] };
export type UsageDiagnostics = Record<AgentName, UsageSourceDiagnostics>;

export interface UsageReaderResult {
  events: UsageEvent[];
  diagnostics: TranscriptDiagnostics & { warningMessages?: string[] };
}

export type UsageReader = (input: ReadTranscriptsInput) => Promise<UsageReaderResult>;

export interface ReadAllUsageInput extends ReadTranscriptsInput {
  readers?: Partial<Record<AgentName, UsageReader>>;
}

export interface ReadAllUsageResult {
  events: UsageEvent[];
  diagnostics: UsageDiagnostics;
}

const agentOrder: AgentName[] = ['claude-code', 'codex', 'opencode'];

const defaultReaders: Record<AgentName, UsageReader> = {
  'claude-code': readClaudeTranscripts,
  codex: readCodexUsage,
  opencode: readOpencodeUsage,
};

export async function readAllUsage(input: ReadAllUsageInput): Promise<ReadAllUsageResult> {
  const events: UsageEvent[] = [];
  const diagnostics = {} as UsageDiagnostics;

  for (const agent of agentOrder) {
    const reader = input.readers?.[agent] ?? defaultReaders[agent];
    try {
      const result = await reader(input);
      events.push(...result.events);
      diagnostics[agent] = normalizeDiagnostics(result.diagnostics);
    } catch (error) {
      diagnostics[agent] = {
        ...emptyDiagnostics(),
        warningMessages: [`${agent} skipped: ${errorMessage(error)}`],
      };
    }
  }

  return { events, diagnostics };
}

function normalizeDiagnostics(diagnostics: UsageReaderResult['diagnostics']): UsageSourceDiagnostics {
  return {
    scannedFileCount: diagnostics.scannedFileCount,
    malformedLineCount: diagnostics.malformedLineCount,
    dedupedEventCount: diagnostics.dedupedEventCount,
    skippedLineCount: diagnostics.skippedLineCount,
    warningMessages: diagnostics.warningMessages ?? [],
  };
}

function emptyDiagnostics(): UsageSourceDiagnostics {
  return {
    scannedFileCount: 0,
    malformedLineCount: 0,
    dedupedEventCount: 0,
    skippedLineCount: 0,
    warningMessages: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
