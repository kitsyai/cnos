import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const fromRepoRoot = (...segments: string[]): string => path.resolve(repoRoot, ...segments);

export default defineConfig({
  resolve: {
    alias: [
      { find: '@kitsy/cnos/configure', replacement: fromRepoRoot('packages/cnos/src/configure/index.ts') },
      { find: '@kitsy/cnos/create', replacement: fromRepoRoot('packages/cnos/src/configure/index.ts') },
      { find: '@kitsy/cnos/build', replacement: fromRepoRoot('packages/cnos/src/build/index.ts') },
      { find: '@kitsy/cnos/browser', replacement: fromRepoRoot('packages/cnos/src/browser/index.ts') },
      { find: '@kitsy/cnos/runtime', replacement: fromRepoRoot('packages/cnos/src/runtime/index.ts') },
      { find: '@kitsy/cnos/internal', replacement: fromRepoRoot('packages/cnos/src/internal.ts') },
      { find: '@kitsy/cnos-core', replacement: fromRepoRoot('packages/core/src/index.ts') },
      { find: '@kitsy/cnos', replacement: fromRepoRoot('packages/cnos/src/index.ts') },
      { find: '@kitsy/cnos-cli', replacement: fromRepoRoot('packages/cli/src/index.ts') },
      { find: '@kitsy/cnos-plugin-filesystem', replacement: fromRepoRoot('plugins/filesystem/src/index.ts') },
      { find: '@kitsy/cnos-plugin-dotenv', replacement: fromRepoRoot('plugins/dotenv/src/index.ts') },
      { find: '@kitsy/cnos-plugin-process-env', replacement: fromRepoRoot('plugins/process-env/src/index.ts') },
      { find: '@kitsy/cnos-plugin-cli-args', replacement: fromRepoRoot('plugins/cli-args/src/index.ts') },
      { find: '@kitsy/cnos-plugin-basic-schema', replacement: fromRepoRoot('plugins/basic-schema/src/index.ts') },
      { find: '@kitsy/cnos-plugin-env-export', replacement: fromRepoRoot('plugins/env-export/src/index.ts') },
      { find: '@kitsy/cnos-vault-testkit', replacement: fromRepoRoot('packages/vault-testkit/src/index.ts') },
      { find: '@kitsy/cnos-vault-fake', replacement: fromRepoRoot('packages/vault-fake/src/index.ts') },
      { find: '@kitsy/cnos-var-server', replacement: fromRepoRoot('packages/var-server/src/index.ts') },
      { find: '@kitsy/cnos-var-testkit', replacement: fromRepoRoot('packages/var-testkit/src/index.ts') },
    ],
  },
  test: {
    passWithNoTests: false,
  },
});
