import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@kitsy/cnos/configure', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/configure/index.ts' },
      { find: '@kitsy/cnos/create', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/configure/index.ts' },
      { find: '@kitsy/cnos/build', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/build/index.ts' },
      { find: '@kitsy/cnos/browser', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/browser/index.ts' },
      { find: '@kitsy/cnos/runtime', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/runtime/index.ts' },
      { find: '@kitsy/cnos/internal', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/internal.ts' },
      { find: '@kitsy/cnos-core', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/core/src/index.ts' },
      { find: '@kitsy/cnos', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/index.ts' },
      { find: '@kitsy/cnos-cli', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cli/src/index.ts' },
      { find: '@kitsy/cnos-plugin-filesystem', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/filesystem/src/index.ts' },
      { find: '@kitsy/cnos-plugin-dotenv', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/dotenv/src/index.ts' },
      { find: '@kitsy/cnos-plugin-process-env', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/process-env/src/index.ts' },
      { find: '@kitsy/cnos-plugin-cli-args', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/cli-args/src/index.ts' },
      { find: '@kitsy/cnos-plugin-basic-schema', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/basic-schema/src/index.ts' },
      { find: '@kitsy/cnos-plugin-env-export', replacement: 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/env-export/src/index.ts' },
    ],
  },
  test: {
    passWithNoTests: false,
  },
});
