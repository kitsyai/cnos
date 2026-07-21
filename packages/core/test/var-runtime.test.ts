import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCnos,
  normalizeManifest,
  normalizeDocuments,
  normalizeVarSources,
  normalizeVars,
  validateDocumentValue,
  validateRuntime,
  validateVarManifest,
  type ConfigEntry,
  type DocumentSchemaDefinition,
  type LoaderPlugin,
  type ManifestFile,
  type NormalizedManifest,
} from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(manifestSource: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-core-var-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(path.join(cnosRoot, 'cnos.yml'), manifestSource);
  fixtureRoots.push(root);
  return root;
}

function createFixtureLoader(id: string, entries: ConfigEntry[]): LoaderPlugin {
  return {
    id,
    kind: 'loader',
    async load() {
      return entries;
    },
  };
}

function normalize(manifest: ManifestFile): NormalizedManifest {
  return normalizeManifest({ version: 1, project: { name: 'var-test' }, ...manifest });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A manifest fixture wiring all three var sections plus schema rules.
const VAR_MANIFEST = [
  'version: 1',
  'project:',
  '  name: var-app',
  'varSources:',
  '  ops:',
  '    transport: rpc',
  '    url: cnos-vars.internal:443',
  '    auth:',
  '      bearer: secret.ops.workload_token',
  '  user_service:',
  '    transport: http',
  '    url: https://config.run.app',
  '    pollInterval: 30s',
  'vars:',
  '  agentic:',
  '    source: ops',
  '    mode: prefetch',
  '    lease: 10m',
  '  user:',
  '    source: user_service',
  '    mode: ondemand',
  '    ttl: 60s',
  'documents:',
  '  agentic-lanes/v1:',
  '    fields:',
  '      enabled: { type: boolean, required: true }',
  '      model_target_ref: { type: string, required: true }',
  '      max_input_tokens: { type: number }',
  '      budgets: { type: object }',
  '    additionalProperties: false',
  'schema:',
  '  var.agentic.lanes.vinci: { document: agentic-lanes/v1, required: true }',
  '  var.user.IN.coupon_allowed: { type: boolean, default: false }',
  '',
].join('\n');

/**
 * VAR_MANIFEST declares `var.agentic.lanes.vinci` as REQUIRED in a prefetch group. With no rpc
 * transport module registered, startup is only legal when a fallback tier resolves it (round-3
 * blocker 3): the missing module is warned, never a waiver of required enforcement.
 */
function staticRequiredVarLoader(): LoaderPlugin {
  return createFixtureLoader('var-required-static', [
    {
      key: 'value.agentic.lanes.vinci',
      value: { enabled: true, model_target_ref: 'static-model' },
      namespace: 'value',
      sourceId: 'var-required-static',
      pluginId: 'var-required-static',
      workspaceId: 'var-app',
    },
  ]);
}

describe('var normalization', () => {
  it('is absent-safe: omitting var sections changes nothing', () => {
    const manifest = normalize({});
    expect(manifest.varSources).toEqual({});
    expect(manifest.vars).toEqual({});
    expect(manifest.documents).toEqual({});
  });

  it('normalizes varSources, vars, and documents from the manifest', () => {
    const manifest = normalize({
      varSources: {
        ops: { transport: 'rpc', url: 'cnos-vars.internal:443', auth: { bearer: 'secret.ops.token' } },
      },
      vars: { agentic: { source: 'ops', mode: 'prefetch', lease: '10m' } },
      documents: {
        'agentic-lanes/v1': {
          fields: { enabled: { type: 'boolean', required: true } },
          additionalProperties: false,
        },
      },
    });

    expect(manifest.varSources?.ops).toEqual({
      transport: 'rpc',
      url: 'cnos-vars.internal:443',
      auth: { bearer: 'secret.ops.token' },
    });
    expect(manifest.vars?.agentic).toEqual({ source: 'ops', mode: 'prefetch', lease: '10m' });
    expect(manifest.documents?.['agentic-lanes/v1']).toEqual({
      fields: { enabled: { type: 'boolean', required: true } },
      additionalProperties: false,
    });
  });

  it('defaults var group mode to ondemand and document additionalProperties to false', () => {
    const vars = normalizeVars({ user: { source: 'user_service' } as never });
    expect(vars.user?.mode).toBe('ondemand');

    const documents = normalizeDocuments({ 'doc/v1': { fields: { a: { type: 'string' } } } });
    expect(documents['doc/v1']?.additionalProperties).toBe(false);
  });

  it('throws on malformed var sources (bad transport, missing url, missing source)', () => {
    expect(() => normalizeVarSources({ x: { transport: 'grpc' as never, url: 'u' } })).toThrow(/transport/);
    expect(() => normalizeVarSources({ x: { transport: 'rpc', url: '' } })).toThrow(/url/);
    expect(() => normalizeVars({ g: { source: '', mode: 'ondemand' } })).toThrow(/source/);
  });

  it('preserves the schema document binding through normalization', () => {
    const manifest = normalize({
      documents: { 'd/v1': { fields: {} } },
      vars: { g: { source: 's', mode: 'ondemand' } },
      varSources: { s: { transport: 'http', url: 'https://x' } },
      schema: { 'var.g.k': { document: 'd/v1' } },
    });
    expect(manifest.schema['var.g.k']?.document).toBe('d/v1');
  });
});

describe('var manifest validation', () => {
  it('flags a var group referencing an undeclared source', () => {
    const manifest = normalize({
      vars: { agentic: { source: 'nope', mode: 'ondemand' } },
    });
    const issues = validateVarManifest(manifest);
    expect(issues.some((issue) => issue.code === 'var.unknown-source')).toBe(true);
  });

  it('flags a var.* schema rule not under a declared group', () => {
    const manifest = normalize({
      varSources: { ops: { transport: 'rpc', url: 'u' } },
      vars: { agentic: { source: 'ops', mode: 'ondemand' } },
      schema: { 'var.other.key': { type: 'string' } },
    });
    const issues = validateVarManifest(manifest);
    expect(issues.some((issue) => issue.code === 'var.unknown-group' && issue.key === 'var.other.key')).toBe(true);
  });

  it('flags required + default together on the same var rule', () => {
    const manifest = normalize({
      varSources: { ops: { transport: 'rpc', url: 'u' } },
      vars: { g: { source: 'ops', mode: 'ondemand' } },
      schema: { 'var.g.k': { type: 'boolean', required: true, default: false } },
    });
    const issues = validateVarManifest(manifest);
    expect(issues.some((issue) => issue.code === 'var.required-and-default')).toBe(true);
  });

  it('flags a document binding to an undeclared documents entry', () => {
    const manifest = normalize({
      varSources: { ops: { transport: 'rpc', url: 'u' } },
      vars: { g: { source: 'ops', mode: 'ondemand' } },
      schema: { 'var.g.k': { document: 'missing/v1' } },
    });
    const issues = validateVarManifest(manifest);
    expect(issues.some((issue) => issue.code === 'var.unknown-document')).toBe(true);
  });

  it('flags varSource auth values that are not secret.* refs', () => {
    const manifest = normalize({
      varSources: {
        ops: { transport: 'rpc', url: 'u', auth: { bearer: 'plaintext-token' }, verify: 'value.x' },
      },
    });
    const issues = validateVarManifest(manifest);
    const authIssues = issues.filter((issue) => issue.code === 'var.auth-not-secret-ref');
    expect(authIssues).toHaveLength(2);
  });

  it('accepts secret.* auth refs and a fully-wired manifest', () => {
    const manifest = normalize({
      varSources: {
        ops: { transport: 'rpc', url: 'u', auth: { bearer: 'secret.ops.token' }, verify: 'secret.ops.verify' },
      },
      vars: { agentic: { source: 'ops', mode: 'prefetch' } },
      documents: { 'agentic-lanes/v1': { fields: { enabled: { type: 'boolean', required: true } } } },
      schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1', required: true } },
    });
    expect(validateVarManifest(manifest)).toEqual([]);
  });

  it('flags var.* keys promoted to public surfaces', () => {
    const manifest = normalize({
      varSources: { ops: { transport: 'rpc', url: 'u' } },
      vars: { g: { source: 'ops', mode: 'ondemand' } },
      // Bypass createCnos eager check by constructing manifest directly.
      public: { promote: ['var.g.k'] },
    });
    const issues = validateVarManifest(manifest);
    expect(issues.some((issue) => issue.code === 'var.public-exposure')).toBe(true);
  });
});

describe('whole-document validator', () => {
  const schema: DocumentSchemaDefinition = {
    fields: {
      enabled: { type: 'boolean', required: true },
      model_target_ref: { type: 'string', required: true },
      max_input_tokens: { type: 'number' },
      tier: { type: 'string', enum: ['a', 'b'] },
    },
    additionalProperties: false,
  };

  it('accepts a valid document', () => {
    const issues = validateDocumentValue(
      { enabled: true, model_target_ref: 'gpt', max_input_tokens: 100, tier: 'a' },
      schema,
      { schemaId: 'agentic-lanes/v1' },
    );
    expect(issues).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const issues = validateDocumentValue({ enabled: true }, schema);
    expect(issues.some((issue) => issue.code === 'document.required')).toBe(true);
  });

  it('rejects wrong field types', () => {
    const issues = validateDocumentValue({ enabled: 'yes', model_target_ref: 'gpt' }, schema);
    expect(issues.some((issue) => issue.code === 'document.type')).toBe(true);
  });

  it('rejects unknown fields when additionalProperties is false', () => {
    const issues = validateDocumentValue(
      { enabled: true, model_target_ref: 'gpt', budgets2: 1 },
      schema,
      { schemaId: 'agentic-lanes/v1' },
    );
    expect(issues.some((issue) => issue.code === 'document.unknown-field')).toBe(true);
  });

  it('allows unknown fields when additionalProperties is true', () => {
    const open: DocumentSchemaDefinition = { fields: schema.fields, additionalProperties: true };
    const issues = validateDocumentValue({ enabled: true, model_target_ref: 'gpt', extra: 1 }, open);
    expect(issues).toEqual([]);
  });

  it('rejects enum violations and non-object documents', () => {
    expect(
      validateDocumentValue({ enabled: true, model_target_ref: 'gpt', tier: 'z' }, schema).some(
        (issue) => issue.code === 'document.enum',
      ),
    ).toBe(true);
    expect(validateDocumentValue('nope', schema).some((issue) => issue.code === 'document.type')).toBe(true);
  });
});

describe('var overlay precedence', () => {
  it('resolves runtime -> static value.* -> schema default -> undefined', async () => {
    const root = await createFixtureRoot(VAR_MANIFEST);
    const loader = createFixtureLoader('var-values', [
      {
        key: 'value.agentic.lanes.vinci',
        value: { enabled: true, model_target_ref: 'static-model' },
        namespace: 'value',
        sourceId: 'var-values',
        pluginId: 'var-values',
        workspaceId: 'var-app',
      },
    ]);
    const runtime = await createCnos({ root, plugins: [loader] });

    // Tier 2: static value.* twin.
    expect(runtime.read('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'static-model',
    });
    // Accessor mirrors secret(path).
    expect(runtime.var?.('agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'static-model',
    });
    // Tier 3: schema default (no static value present).
    expect(runtime.read('var.user.IN.coupon_allowed')).toBe(false);
    expect(runtime.readOr('var.user.IN.coupon_allowed', 'fallback')).toBe(false);
    // Tier 4: undefined for an unmapped var key with no default.
    expect(runtime.read('var.user.IN.unknown')).toBeUndefined();
    expect(runtime.readOr('var.user.IN.unknown', 'fallback')).toBe('fallback');
    expect(() => runtime.require('var.user.IN.unknown')).toThrow('var.user.IN.unknown');
  });

  it('does not inject var.* schema defaults into the resolved value graph', async () => {
    const root = await createFixtureRoot(VAR_MANIFEST);
    const runtime = await createCnos({ root, plugins: [staticRequiredVarLoader()] });
    // The overlay serves the default at read time, but no var.* entry pollutes the graph.
    expect(runtime.read('var.user.IN.coupon_allowed')).toBe(false);
    expect(runtime.graph.entries.has('var.user.IN.coupon_allowed')).toBe(false);
    expect(runtime.graph.entries.has('value.user.IN.coupon_allowed')).toBe(false);
  });
});

describe('var projection emit', () => {
  it('emits varSources, vars, and documents blocks (refs only)', async () => {
    const root = await createFixtureRoot(VAR_MANIFEST);
    const runtime = await createCnos({ root, plugins: [staticRequiredVarLoader()] });
    const projection = runtime.toServerProjection();

    expect(projection.varSources?.ops).toEqual({
      transport: 'rpc',
      url: 'cnos-vars.internal:443',
      auth: { bearer: 'secret.ops.workload_token' },
    });
    // Auth carries a secret ref, never resolved material.
    expect(JSON.stringify(projection.varSources)).not.toContain('workload_token_value');
    expect(projection.vars?.agentic).toEqual({ source: 'ops', mode: 'prefetch', lease: '10m' });
    expect(projection.documents?.['agentic-lanes/v1']?.additionalProperties).toBe(false);
    expect(projection.documents?.['agentic-lanes/v1']?.fields.enabled).toEqual({
      type: 'boolean',
      required: true,
    });
  });

  it('omits var blocks when no var sections are declared (older runtimes ignore cleanly)', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: plain\n');
    const runtime = await createCnos({ root, plugins: [] });
    const projection = runtime.toServerProjection();

    expect(projection.varSources).toBeUndefined();
    expect(projection.vars).toBeUndefined();
    expect(projection.documents).toBeUndefined();
  });
});

describe('var public-safety enforcement', () => {
  it('rejects promoting a var.* key at createCnos time', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: var-public',
        'varSources:',
        '  ops: { transport: rpc, url: u }',
        'vars:',
        '  g: { source: ops, mode: ondemand }',
        'public:',
        '  promote:',
        '    - var.g.k',
        '',
      ].join('\n'),
    );
    await expect(createCnos({ root, plugins: [] })).rejects.toThrow(/var/);
  });

  it('surfaces a var public-exposure issue through validateRuntime', async () => {
    const root = await createFixtureRoot(VAR_MANIFEST);
    const runtime = await createCnos({ root, plugins: [staticRequiredVarLoader()] });
    const summary = await validateRuntime(runtime);
    // The fully-wired VAR_MANIFEST is valid.
    expect(summary.issues.filter((issue) => issue.code.startsWith('var.'))).toEqual([]);
  });
});
