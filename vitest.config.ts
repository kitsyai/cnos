import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kitsy/cnos-core': 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/core/src/index.ts',
      '@kitsy/cnos/internal': 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/internal.ts',
      '@kitsy/cnos': 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cnos/src/index.ts',
      '@kitsy/cnos-cli': 'C:/Users/pkvsi/Wks/kitsy/cnos/packages/cli/src/index.ts',
      '@kitsy/cnos-plugin-filesystem': 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/filesystem/src/index.ts',
      '@kitsy/cnos-plugin-dotenv': 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/dotenv/src/index.ts',
      '@kitsy/cnos-plugin-process-env': 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/process-env/src/index.ts',
      '@kitsy/cnos-plugin-cli-args': 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/cli-args/src/index.ts',
      '@kitsy/cnos-plugin-basic-schema': 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/basic-schema/src/index.ts',
      '@kitsy/cnos-plugin-env-export': 'C:/Users/pkvsi/Wks/kitsy/cnos/plugins/env-export/src/index.ts',
    },
  },
  test: {
    passWithNoTests: false,
  },
});
