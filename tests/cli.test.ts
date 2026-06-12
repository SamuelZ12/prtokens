import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isEntrypoint, main } from '../src/cli.js';

describe('main', () => {
  it('returns success for the initial scaffold', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main()).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith('prtokens scaffold is ready');
  });
});

describe('isEntrypoint', () => {
  it('matches npm bin symlinks that resolve to the CLI module', () => {
    const cliPath = realpathSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));
    const binDirectory = mkdtempSync(join(tmpdir(), 'prtokens-bin-'));
    const binPath = join(binDirectory, 'prtokens');
    symlinkSync(cliPath, binPath);

    expect(isEntrypoint(pathToFileURL(cliPath).href, binPath)).toBe(true);
  });
});
