import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyManifestMappings,
  proposeMapping,
  rewriteSourceFiles,
  scanEnvUsage,
} from '../src/internal.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createMigrateFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-migrate-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    ['version: 1', 'project:', '  name: migrate-fixture'].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'server.ts'),
    [
      'const host = process.env.DATABASE_HOST;',
      "const password = process.env['DATABASE_PASSWORD'];",
      'const publicUrl = import.meta.env.VITE_API_URL;',
    ].join('\n'),
  );

  return root;
}

describe('@kitsy/cnos migrate helpers', () => {
  it('scans env usage and proposes logical mappings', async () => {
    const root = await createMigrateFixture();
    const usages = await scanEnvUsage(path.join(root, 'src'));

    expect(usages.map((usage) => usage.envVar)).toEqual(['DATABASE_HOST', 'DATABASE_PASSWORD', 'VITE_API_URL']);
    expect(proposeMapping('DATABASE_HOST')).toEqual({
      envVar: 'DATABASE_HOST',
      namespace: 'value',
      logicalPath: 'database.host',
      logicalKey: 'value.database.host',
      public: false,
    });
    expect(proposeMapping('DATABASE_PASSWORD')).toEqual({
      envVar: 'DATABASE_PASSWORD',
      namespace: 'secret',
      logicalPath: 'database.password',
      logicalKey: 'secret.database.password',
      public: false,
    });
    expect(proposeMapping('VITE_API_URL')).toEqual({
      envVar: 'VITE_API_URL',
      namespace: 'value',
      logicalPath: 'api.url',
      logicalKey: 'value.api.url',
      public: true,
      framework: 'vite',
    });
  });

  it('applies manifest mappings and rewrites supported sources with backups', async () => {
    const root = await createMigrateFixture();
    const proposals = ['DATABASE_HOST', 'DATABASE_PASSWORD', 'VITE_API_URL'].map((envVar) => proposeMapping(envVar));
    const manifestResult = await applyManifestMappings(proposals, root);

    expect(manifestResult.appliedMappings).toBe(3);
    expect(await readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).toContain(
      'DATABASE_HOST: value.database.host',
    );
    expect(await readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).toContain(
      '- value.api.url',
    );

    const usages = await scanEnvUsage(path.join(root, 'src'));
    const rewriteResult = await rewriteSourceFiles(
      usages.filter((usage) => usage.kind === 'process-env'),
      new Map(proposals.map((proposal) => [proposal.envVar, proposal])),
    );

    expect(rewriteResult.rewrittenFiles).toContain(path.join(root, 'src', 'server.ts'));
    expect(rewriteResult.backupFiles).toContain(path.join(root, 'src', 'server.ts.bak'));
    expect(await readFile(path.join(root, 'src', 'server.ts'), 'utf8')).toContain(
      "import cnos from '@kitsy/cnos';",
    );
    expect(await readFile(path.join(root, 'src', 'server.ts'), 'utf8')).toContain(
      'cnos.value("database.host")',
    );
    expect(await readFile(path.join(root, 'src', 'server.ts'), 'utf8')).toContain(
      'cnos.secret("database.password")',
    );
  });
});
