import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    resolve: ['@kitsy/cnos-core'],
  },
  noExternal: ['@kitsy/cnos-core'],
});
