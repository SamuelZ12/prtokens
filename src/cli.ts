#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function main(): Promise<number> {
  console.log('prtokens scaffold is ready');
  return 0;
}

export function isEntrypoint(moduleUrl: string, entrypointPath: string | undefined): boolean {
  return entrypointPath !== undefined && realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entrypointPath);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
