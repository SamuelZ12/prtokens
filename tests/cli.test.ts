import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

describe('main', () => {
  it('returns success for the initial scaffold', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main()).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith('prtokens scaffold is ready');
  });
});
