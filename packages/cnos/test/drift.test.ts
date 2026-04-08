import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnos } from '../src/createCnos.js';
import { compareSchemaToGraph, formatDriftReport } from '../src/internal.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createDriftFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-drift-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: drift-fixture',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
      'schema:',
      '  value.server.port:',
      '    type: number',
      '    required: true',
      '  value.server.host:',
      '    type: string',
      '    default: localhost',
      '  secret.db.password:',
      '    type: string',
      '    required: true',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    ['server:', '  port: "3000"', 'legacy:', '  timeout: 5000'].join('\n'),
  );

  return root;
}

describe('@kitsy/cnos drift', () => {
  it('reports missing, undeclared, type mismatch, and defaults applied', async () => {
    const root = await createDriftFixture();
    const runtime = await createCnos({ root, processEnv: {} });

    const report = compareSchemaToGraph(runtime);

    expect(report.missing).toEqual([
      expect.objectContaining({
        key: 'secret.db.password',
      }),
    ]);
    expect(report.undeclared).toEqual([
      expect.objectContaining({
        key: 'value.legacy.timeout',
      }),
    ]);
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        key: 'value.server.port',
        expectedType: 'number',
        actualType: 'string',
      }),
    ]);
    expect(report.defaultsApplied).toEqual([
      expect.objectContaining({
        key: 'value.server.host',
        value: 'localhost',
      }),
    ]);

    const formatted = formatDriftReport(report);
    expect(formatted).toContain('Missing (required, not defined):');
    expect(formatted).toContain('value.server.port (schema: number, actual: string "3000")');
    expect(formatted).toContain('value.server.host (using default: "localhost")');
  });

  it('ignores transient process env keys in undeclared drift output but still checks declared keys', async () => {
    const root = await createDriftFixture();
    const runtime = await createCnos({
      root,
      processEnv: {
        ANDROID_HOME: 'C:\\Android\\Sdk',
        SERVER_PORT: 'not-a-number',
      },
    });

    const report = compareSchemaToGraph(runtime);

    expect(report.undeclared.some((issue) => issue.key === 'value.android.home')).toBe(false);
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        key: 'value.server.port',
        expectedType: 'number',
        actualType: 'string',
        value: 'not-a-number',
      }),
    ]);
  });
});
