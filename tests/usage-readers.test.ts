import { describe, expect, it, vi } from 'vitest';
import { readAllUsage } from '../src/usage-readers.js';
import type { TranscriptDiagnostics } from '../src/transcript-reader.js';
import type { AgentName, UsageEvent } from '../src/types.js';
import type { UsageReader } from '../src/usage-readers.js';

function usageEvent(id: string, agent: AgentName): UsageEvent {
  return {
    id,
    agent,
    timestamp: '2026-06-12T10:00:00.000Z',
    model: 'gpt-5.5',
    inputTokens: 1,
    outputTokens: 2,
    cacheWriteTokens: 3,
    cacheReadTokens: 4,
    sessionId: `${agent}-session`,
  };
}

function diagnostics(overrides: Partial<TranscriptDiagnostics> = {}): TranscriptDiagnostics {
  return {
    scannedFileCount: 0,
    malformedLineCount: 0,
    dedupedEventCount: 0,
    skippedLineCount: 0,
    ...overrides,
  };
}

describe('readAllUsage', () => {
  it('merges events and diagnostics from all readers', async () => {
    const readers: Partial<Record<AgentName, UsageReader>> = {
      'claude-code': vi.fn(async () => ({
        events: [usageEvent('c1', 'claude-code')],
        diagnostics: diagnostics({ scannedFileCount: 2 }),
      })),
      codex: vi.fn(async () => ({
        events: [usageEvent('x1', 'codex')],
        diagnostics: diagnostics({ malformedLineCount: 1 }),
      })),
      opencode: vi.fn(async () => ({
        events: [usageEvent('o1', 'opencode')],
        diagnostics: {
          ...diagnostics(),
          warningMessages: ['OpenCode skipped one DB'],
        },
      })),
    };

    const result = await readAllUsage({ repoRoot: '/repo', readers });

    expect(result.events.map((event) => event.id)).toEqual(['c1', 'x1', 'o1']);
    expect(result.diagnostics['claude-code'].scannedFileCount).toBe(2);
    expect(result.diagnostics.codex.malformedLineCount).toBe(1);
    expect(result.diagnostics.opencode.warningMessages).toEqual(['OpenCode skipped one DB']);
  });

  it('isolates a reader failure and keeps other readers running', async () => {
    const readers: Partial<Record<AgentName, UsageReader>> = {
      'claude-code': vi.fn(async () => {
        throw new Error('broken claude file');
      }),
      codex: vi.fn(async () => ({
        events: [usageEvent('x1', 'codex')],
        diagnostics: diagnostics(),
      })),
      opencode: vi.fn(async () => ({
        events: [],
        diagnostics: diagnostics(),
      })),
    };

    const result = await readAllUsage({ repoRoot: '/repo', readers });

    expect(result.events.map((event) => event.id)).toEqual(['x1']);
    expect(result.diagnostics['claude-code'].warningMessages).toEqual(['claude-code skipped: broken claude file']);
  });
});
