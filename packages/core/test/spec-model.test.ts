import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadManifest, type SchemaRule } from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(manifestSource: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-core-spec-model-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(path.join(cnosRoot, 'cnos.yml'), manifestSource);
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos-core spec model', () => {
  it('keeps SchemaRule export backward compatible while supporting expanded spec fields', () => {
    const rule: SchemaRule = {
      type: 'string',
      required: true,
      summary: '  App name  ',
      usedBy: ['server runtime'],
    };

    expect(rule.type).toBe('string');
    expect(rule.summary).toBe('  App name  ');
    expect(rule.usedBy).toEqual(['server runtime']);
  });

  it('normalizes expanded schema metadata fields', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'schema:',
        '  value.app.stage:',
        '    type: string',
        '    summary: "  Deployment stage  "',
        '    description: "  Used for env-aware behavior.  "',
        '    usedBy:',
        '      - "  server runtime  "',
        '      - ""',
        '    examples:',
        '      - local',
        '      - stage',
        '    deprecated: true',
        '    deprecationMessage: "  Use value.app.environment instead.  "',
      ].join('\n'),
    );

    const loaded = await loadManifest({ root });

    expect(loaded.manifest.schema['value.app.stage']).toEqual({
      type: 'string',
      summary: 'Deployment stage',
      description: 'Used for env-aware behavior.',
      usedBy: ['server runtime'],
      examples: ['local', 'stage'],
      deprecated: true,
      deprecationMessage: 'Use value.app.environment instead.',
    });
  });

  it('rejects secret schema entries that include default, examples, or enum', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'schema:',
        '  secret.db.password:',
        '    type: string',
        '    default: super-secret',
      ].join('\n'),
    );

    await expect(loadManifest({ root })).rejects.toThrow('secret.db.password');
    await expect(loadManifest({ root })).rejects.toThrow('default');
    await expect(loadManifest({ root })).rejects.toThrow('vault');
    await expect(loadManifest({ root })).rejects.toThrow('schema.secret.db.password.default');
  });

  it('rejects schema entries with invalid regex patterns', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'schema:',
        '  value.app.name:',
        '    type: string',
        '    pattern: "["',
      ].join('\n'),
    );

    await expect(loadManifest({ root })).rejects.toThrow('value.app.name');
    await expect(loadManifest({ root })).rejects.toThrow('"pattern"');
    await expect(loadManifest({ root })).rejects.toThrow('valid regex');
  });
});
