import { defineConfig } from 'tsup';

const internalPackages = [
  '@kitsy/cnos-core',
  '@kitsy/cnos-plugin-basic-schema',
  '@kitsy/cnos-plugin-cli-args',
  '@kitsy/cnos-plugin-dotenv',
  '@kitsy/cnos-plugin-env-export',
  '@kitsy/cnos-plugin-filesystem',
  '@kitsy/cnos-plugin-process-env',
  '@kitsy/cnos-var-http',
];

export default defineConfig({
  tsconfig: 'tsconfig.build.json',
  entry: [
    'src/index.ts',
    'src/configure/index.ts',
    'src/internal.ts',
    'src/build/index.ts',
    'src/browser/index.ts',
    'src/runtime/index.ts',
    'src/plugin/basic-schema.ts',
    'src/plugin/cli-args.ts',
    'src/plugin/dotenv.ts',
    'src/plugin/env-export.ts',
    'src/plugin/filesystem.ts',
    'src/plugin/process-env.ts',
    'src/plugin/var-http.ts',
    'src/varReceiver.ts',
  ],
  format: ['esm', 'cjs'],
  dts: {
    resolve: true,
  },
  noExternal: internalPackages,
});
