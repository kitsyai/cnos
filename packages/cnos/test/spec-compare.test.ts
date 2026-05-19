import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnos } from '../src/createCnos.js';
import { compareSpecToGraph } from '../src/internal.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSpecCompareFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-spec-compare-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: spec-compare-fixture',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
      'schema:',
      '  value.server.port:',
      '    type: number',
      '    required: true',
      '    summary: HTTP port',
      '  value.server.host:',
      '    type: string',
      '    default: localhost',
      '  value.app.stage:',
      '    type: string',
      '    enum: [local, stage, prod]',
      '  value.app.name:',
      '    type: string',
      '    pattern: "^cnos-"',
      '  value.legacy.flag:',
      '    type: boolean',
      '    deprecated: true',
      '  secret.db.password:',
      '    type: string',
      '    required: true',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    [
      'server:',
      '  port: "3000"',
      'app:',
      '  stage: dev',
      '  name: app',
      'legacy:',
      '  flag: true',
      'extra:',
      '  timeout: 5000',
    ].join('\n'),
  );

  return root;
}

describe('@kitsy/cnos spec compare', () => {
  it('reports spec comparison statuses for doctor-oriented diagnostics', async () => {
    const root = await createSpecCompareFixture();
    const runtime = await createCnos({ root, processEnv: {} });

    const report = compareSpecToGraph(runtime);
    const statuses = report.issues.map((issue) => issue.status);

    expect(statuses).toContain('missing_required');
    expect(statuses).toContain('undeclared');
    expect(statuses).toContain('type_mismatch');
    expect(statuses).toContain('enum_mismatch');
    expect(statuses).toContain('pattern_mismatch');
    expect(statuses).toContain('default_applied');
    expect(statuses).toContain('deprecated_in_use');

    expect(report.summary).toEqual({
      missingRequired: 1,
      undeclared: 1,
      typeMismatch: 1,
      enumMismatch: 1,
      patternMismatch: 1,
      defaultApplied: 1,
      deprecatedInUse: 1,
    });
  });

  it('ignores transient runtime source keys in undeclared output', async () => {
    const root = await createSpecCompareFixture();
    const runtime = await createCnos({
      root,
      processEnv: {
        ANDROID_HOME: 'C:\\Android\\Sdk',
      },
    });

    const report = compareSpecToGraph(runtime);

    expect(report.issues.some((issue) => issue.status === 'undeclared' && issue.key === 'value.android.home')).toBe(
      false,
    );
  });

  it('does not crash when a malformed pattern reaches comparison', async () => {
    const root = await createSpecCompareFixture();
    const runtime = await createCnos({ root, processEnv: {} });
    runtime.manifest.schema['value.app.name'] = {
      ...(runtime.manifest.schema['value.app.name'] ?? {}),
      pattern: '[',
    };

    expect(() => compareSpecToGraph(runtime)).not.toThrow();
    const report = compareSpecToGraph(runtime);
    expect(
      report.issues.some((issue) => issue.key === 'value.app.name' && issue.status === 'pattern_mismatch'),
    ).toBe(true);
  });
});
