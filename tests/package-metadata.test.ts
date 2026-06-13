import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package metadata', () => {
  it('publishes the built ESM index as the package entrypoint', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

    expect(packageJson.main).toBe('./dist/index.js');
    expect(packageJson.types).toBe('./dist/index.d.ts');
    expect(packageJson.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    });
  });
});
