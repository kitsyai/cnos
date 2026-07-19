import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { LiveVarStore, createCnos } from '../src/index.js';

/**
 * Cross-SDK wire fixtures shared with the Go SDK. Its twin is
 * `packages/go/var_crosssdk_test.go`; both read the SAME JSON files under
 * `fixtures/var-cross-sdk/`. If a wire shape changes, both tests move together.
 */
const FIXTURES = path.resolve(fileURLToPath(import.meta.url), '../../../../fixtures/var-cross-sdk');

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

/** Canonical JSON identical to the receiver's default-revision algorithm and Go's canonicalVarJSON. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true }))));
});

const MANIFEST = [
  'version: 1',
  'project:',
  '  name: var-cross-sdk',
  'varSources:',
  '  ops: { transport: http, url: "https://cnos-vars.internal", auth: { bearer: secret.ops.token }, verify: secret.ops.verify }',
  'vars:',
  '  agentic: { source: ops, mode: prefetch, lease: 10m }',
  '  user: { source: ops, mode: ondemand, ttl: 60s }',
  'documents:',
  '  agentic-lanes/v1:',
  '    fields:',
  '      enabled: { type: boolean, required: true }',
  '      model_target_ref: { type: string, required: true }',
  '    additionalProperties: false',
  'schema:',
  '  var.agentic.lanes.vinci: { document: agentic-lanes/v1, required: true }',
  '  var.user.IN.coupon_allowed: { type: boolean, default: false }',
  '',
].join('\n');

interface ProjectionBlocks {
  varSources: unknown;
  vars: unknown;
  documents: unknown;
  schema: Record<string, { document?: string; required?: boolean; type?: string; default?: unknown }>;
}

describe('cross-SDK var wire fixtures', () => {
  it('manifest -> toServerProjection -> JSON matches the shared projection fixture (Go parses the same file)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-xsdk-'));
    roots.push(root);
    await mkdir(path.join(root, 'cnos'), { recursive: true });
    await writeFile(path.join(root, 'cnos', 'cnos.yml'), MANIFEST);

    const runtime = await createCnos({ root, plugins: [] });
    const projection = runtime.toServerProjection();
    const fixture = readFixture<ProjectionBlocks>('projection.json');

    // The var-only `schema` block is the heart of decision 2 — assert it byte-for-byte.
    expect(projection.schema).toEqual(fixture.schema);
    expect(projection.varSources).toEqual(fixture.varSources);
    expect(projection.vars).toEqual(fixture.vars);
    expect(projection.documents).toEqual(fixture.documents);

    // `default` rides only when declared: required rule omits it, coupon rule keeps `false`.
    expect(projection.schema?.['var.agentic.lanes.vinci']).not.toHaveProperty('default');
    expect(projection.schema?.['var.user.IN.coupon_allowed']).toHaveProperty('default', false);

    await runtime.close?.();
  });

  it('ingests the shared group-scoped pull response (values keyed by full stripped key)', () => {
    const pull = readFixture<{ generation: number; revision: string; effectiveAt: string; values: Record<string, unknown> }>(
      'pull-response.json',
    );
    const store = new LiveVarStore({
      groups: { agentic: { source: 'ops', mode: 'prefetch', lease: '10m' } },
      schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1', required: true } },
      documents: {
        'agentic-lanes/v1': {
          fields: { enabled: { type: 'boolean', required: true }, model_target_ref: { type: 'string', required: true } },
          additionalProperties: false,
        },
      },
    });

    expect(store.ingest('agentic', 'agentic', pull).ok).toBe(true);
    expect(store.readRuntimeVar('var.agentic.lanes.vinci')).toEqual(pull.values['agentic.lanes.vinci']);
  });

  it('ingests the shared group-scoped push payload (values keyed by full stripped key)', () => {
    const push = readFixture<{ generation: number; revision: string; effectiveAt: string; values: Record<string, unknown> }>(
      'push-payload.json',
    );
    const store = new LiveVarStore({
      groups: { user: { source: 'ops', mode: 'ondemand', ttl: '60s' } },
      schema: { 'var.user.IN.coupon_allowed': { type: 'boolean', default: false } },
      documents: {},
    });

    expect(store.ingest('user', 'user', push).ok).toBe(true);
    expect(store.readRuntimeVar('var.user.IN.coupon_allowed')).toBe(true);
  });

  it('derives the same default push revision as the Go SDK (sha256 of canonical JSON)', () => {
    const fixture = readFixture<{ values: Record<string, unknown>; expectedRevision: string }>('default-revision.json');
    const revision = `sha256:${createHash('sha256').update(canonical(fixture.values)).digest('hex')}`;
    expect(revision).toBe(fixture.expectedRevision);
  });
});
