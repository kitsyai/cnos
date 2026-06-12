import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createCnos,
  type ConfigEntry,
  type LoaderPlugin,
  type SecretVaultProviderFactory,
  type VaultAuthConfig,
  type VaultDefinition,
} from '@kitsy/cnos-core';
import { describe, expect, it, vi } from 'vitest';

export interface SecretVaultProviderConformanceSetup {
  factory: SecretVaultProviderFactory;
  definition: VaultDefinition;
  auth: VaultAuthConfig;
  refs: Record<string, string>;
  missingRef?: string;
  processEnv?: Record<string, string | undefined>;
  capabilities?: {
    writable?: boolean;
  };
}

export interface SecretVaultRuntimeConformanceSetup {
  factory: SecretVaultProviderFactory;
  vaultId: string;
  definition: VaultDefinition;
  refs: Record<string, string>;
  missingRef?: string;
  processEnv?: Record<string, string | undefined>;
  calls?: () => {
    authenticate?: unknown[];
    batchGet?: string[][];
    get?: string[];
  };
  expectedProjectedConfig?: Record<string, unknown>;
  afterReads?: () => void;
  afterRefresh?: () => void;
}

function createSecretLoader(vaultId: string, refs: string[], provider?: string): LoaderPlugin {
  return {
    id: 'test-remote-secret-loader',
    kind: 'loader',
    async load() {
      return refs.map((ref) => ({
        key: `secret.${ref}`,
        value: {
          vault: vaultId,
          ref,
          ...(provider ? { provider } : {}),
        },
        namespace: 'secret',
        sourceId: 'filesystem-secrets',
        pluginId: '@kitsy/cnos/plugins/filesystem-secrets',
        workspaceId: 'default',
      }) satisfies ConfigEntry);
    },
  };
}

function formatYamlScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return String(value);
}

function buildObjectLines(value: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];

  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      lines.push(`${indent}${key}:`);
      lines.push(...buildObjectLines(item as Record<string, unknown>, `${indent}  `));
      continue;
    }

    if (Array.isArray(item)) {
      lines.push(`${indent}${key}:`);
      for (const entry of item) {
        lines.push(`${indent}  - ${formatYamlScalar(entry)}`);
      }
      continue;
    }

    lines.push(`${indent}${key}: ${formatYamlScalar(item)}`);
  }

  return lines;
}

function buildAuthLines(auth: VaultDefinition['auth'], indent = '    '): string[] {
  if (!auth) {
    return [];
  }

  return [
    `${indent}auth:`,
    ...(auth.method ? [`${indent}  method: ${auth.method}`] : []),
    ...(auth.passphrase?.from
      ? [
          `${indent}  passphrase:`,
          `${indent}    from:`,
          ...auth.passphrase.from.map((source) => `${indent}      - ${source}`),
        ]
      : []),
    ...(auth.token?.from
      ? [
          `${indent}  token:`,
          `${indent}    from:`,
          ...auth.token.from.map((source) => `${indent}      - ${source}`),
        ]
      : []),
    ...(auth.config
      ? [
          `${indent}  config:`,
          ...buildObjectLines(auth.config, `${indent}    `),
        ]
      : []),
  ];
}

function buildMappingLines(mapping: Record<string, string> | undefined, indent = '    '): string[] {
  if (!mapping || Object.keys(mapping).length === 0) {
    return [];
  }

  return [
    `${indent}mapping:`,
    ...Object.entries(mapping)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([envVar, ref]) => `${indent}  ${envVar}: ${ref}`),
  ];
}

function buildFallbackLines(definition: VaultDefinition): string[] {
  if (!definition.fallback || definition.fallback.length === 0) {
    return [];
  }

  const lines = ['    fallback:'];

  for (const fallback of definition.fallback) {
    lines.push(`      - provider: ${fallback.provider}`);
    lines.push(...buildAuthLines(fallback.auth, '        '));
    lines.push(...buildMappingLines(fallback.mapping, '        '));
  }

  return lines;
}

async function createManifestRoot(vaultId: string, definition: VaultDefinition): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-vault-conformance-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(
    path.join(cnosRoot, 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: vault-conformance',
      'vaults:',
      `  ${vaultId}:`,
      `    provider: ${definition.provider}`,
      ...buildAuthLines(definition.auth),
      ...buildMappingLines(definition.mapping),
      ...buildFallbackLines(definition),
    ].join('\n'),
  );
  return root;
}

async function writeProjectionFile(projection: unknown): Promise<{ root: string; projectionPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-vault-projection-'));
  const projectionPath = path.join(root, '.cnos-server.json');
  await writeFile(projectionPath, JSON.stringify(projection), 'utf8');
  return { root, projectionPath };
}

function hasHealthCheck(
  provider: unknown,
): provider is { healthCheck: () => Promise<{ ok: boolean; message?: string }> } {
  return Boolean(
    provider &&
      typeof provider === 'object' &&
      'healthCheck' in provider &&
      typeof (provider as { healthCheck?: unknown }).healthCheck === 'function',
  );
}

export function defineSecretVaultProviderConformanceSuite(
  providerName: string,
  setup: () => SecretVaultProviderConformanceSetup,
): void {
  describe(`${providerName} vault provider contract`, () => {
    it('authenticates and exposes authenticated state', async () => {
      const { factory, definition, auth, processEnv } = setup();
      const provider = factory.create('conformance', definition, processEnv);

      expect(provider.isAuthenticated()).toBe(false);
      await provider.authenticate(auth);
      expect(provider.isAuthenticated()).toBe(true);
    });

    it('batch-fetches known refs and omits missing refs', async () => {
      const { factory, definition, auth, refs, missingRef = 'missing.ref', processEnv } = setup();
      const provider = factory.create('conformance', definition, processEnv);
      await provider.authenticate(auth);

      const requestedRefs = [...Object.keys(refs), missingRef];
      const resolved = await provider.batchGet(requestedRefs);

      expect(Object.fromEntries(resolved)).toEqual(refs);
      expect(resolved.has(missingRef)).toBe(false);
    });

    it('supports get, list, and declared mutation capability', async () => {
      const { factory, definition, auth, refs, missingRef = 'missing.ref', processEnv, capabilities } = setup();
      const provider = factory.create('conformance', definition, processEnv);
      await provider.authenticate(auth);
      const [firstRef] = Object.keys(refs);

      if (!firstRef) {
        throw new Error('Provider conformance requires at least one ref fixture.');
      }

      await expect(provider.get(firstRef)).resolves.toBe(refs[firstRef]);
      await expect(provider.get(missingRef)).resolves.toBeUndefined();
      await expect(provider.list()).resolves.toEqual(Object.keys(refs).sort((left, right) => left.localeCompare(right)));

      if (capabilities?.writable) {
        await expect(provider.set(firstRef, 'updated')).resolves.toBeUndefined();
        await expect(provider.delete(firstRef)).resolves.toBeUndefined();
        return;
      }

      await expect(provider.set(firstRef, 'updated')).rejects.toThrow();
      await expect(provider.delete(firstRef)).rejects.toThrow();
    });

    it('reports health when the provider exposes healthCheck', async () => {
      const { factory, definition, processEnv } = setup();
      const provider = factory.create('conformance', definition, processEnv);

      if (!hasHealthCheck(provider)) {
        return;
      }

      await expect(provider.healthCheck()).resolves.toEqual({ ok: true });
    });
  });
}

export function defineSecretVaultRuntimeConformanceSuite(
  providerName: string,
  setup: () => SecretVaultRuntimeConformanceSetup,
): void {
  describe(`${providerName} vault runtime contract`, () => {
    it('hydrates through startup batch resolution and serves repeated reads from CNOS cache', async () => {
      const { factory, vaultId, definition, refs, processEnv, calls, afterReads } = setup();
      const root = await createManifestRoot(vaultId, definition);

      try {
        const runtime = await createCnos({
          root,
          plugins: [createSecretLoader(vaultId, Object.keys(refs))],
          secretVaultProviders: [factory],
          ...(processEnv ? { processEnv } : {}),
        });

        for (const [ref, value] of Object.entries(refs)) {
          expect(runtime.secret(ref)).toBe(value);
          expect(runtime.secret(ref)).toBe(value);
        }

        const snapshot = calls?.();
        if (snapshot) {
          expect(snapshot.authenticate).toHaveLength(1);
          expect(snapshot.batchGet).toEqual([Object.keys(refs)]);
          expect(snapshot.get).toEqual([]);
        }

        afterReads?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps missing refs undefined after vault authentication', async () => {
      const { factory, vaultId, definition, refs, missingRef = 'missing.ref', processEnv } = setup();
      const root = await createManifestRoot(vaultId, definition);

      try {
        const runtime = await createCnos({
          root,
          plugins: [createSecretLoader(vaultId, [...Object.keys(refs), missingRef])],
          secretVaultProviders: [factory],
          ...(processEnv ? { processEnv } : {}),
        });

        expect(runtime.secret(missingRef)).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('refreshes through batch resolution without per-ref get calls', async () => {
      const { factory, vaultId, definition, refs, processEnv, calls, afterRefresh } = setup();
      const root = await createManifestRoot(vaultId, definition);

      try {
        const runtime = await createCnos({
          root,
          plugins: [createSecretLoader(vaultId, Object.keys(refs))],
          secretVaultProviders: [factory],
          ...(processEnv ? { processEnv } : {}),
        });

        await runtime.refreshSecrets();

        const snapshot = calls?.();
        if (snapshot) {
          expect(snapshot.batchGet).toEqual([Object.keys(refs), Object.keys(refs)]);
          expect(snapshot.get).toEqual([]);
        }

        afterRefresh?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('hydrates loaded server projections through compiled-in provider registration', async () => {
      const { factory, vaultId, definition, refs, processEnv } = setup();
      const root = await createManifestRoot(vaultId, definition);
      let projectionRoot: string | undefined;

      try {
        const authoringRuntime = await createCnos({
          root,
          plugins: [createSecretLoader(vaultId, Object.keys(refs))],
          secretResolution: 'lazy',
          ...(processEnv ? { processEnv } : {}),
        });
        const projection = authoringRuntime.toServerProjection();
        const written = await writeProjectionFile(projection);
        projectionRoot = written.root;

        vi.resetModules();
        const previousEnv = new Map<string, string | undefined>();
        for (const [key, value] of Object.entries(processEnv ?? {})) {
          previousEnv.set(key, process.env[key]);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        const { default: cnos } = await import('@kitsy/cnos');
        try {
          await cnos.loadProjection(written.projectionPath, { secretVaultProviders: [factory] });
          await cnos.ready();

          for (const [ref, value] of Object.entries(refs)) {
            expect(cnos.secret(ref)).toBe(value);
          }
        } finally {
          for (const [key, value] of previousEnv) {
            if (value === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = value;
            }
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
        if (projectionRoot) {
          await rm(projectionRoot, { recursive: true, force: true });
        }
        vi.resetModules();
      }
    });

    it('projects only safe vault auth config metadata', async () => {
      const { vaultId, definition, refs, processEnv, expectedProjectedConfig } = setup();

      if (!expectedProjectedConfig) {
        return;
      }

      const root = await createManifestRoot(vaultId, definition);

      try {
        const runtime = await createCnos({
          root,
          plugins: [createSecretLoader(vaultId, Object.keys(refs))],
          secretResolution: 'lazy',
          ...(processEnv ? { processEnv } : {}),
        });
        const projection = runtime.toServerProjection();

        expect(projection.vaults?.[vaultId]?.auth?.config).toEqual(expectedProjectedConfig);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('uses explicit environment fallback when the primary provider is unavailable', async () => {
      const { vaultId, refs } = setup();
      const [firstRef] = Object.keys(refs);

      if (!firstRef) {
        throw new Error('Provider runtime conformance requires at least one ref fixture.');
      }

      const root = await createManifestRoot(vaultId, {
        provider: 'missing-provider-for-fallback',
        fallback: [
          {
            provider: 'environment',
            auth: {
              method: 'environment',
            },
            mapping: {
              CNOS_TEST_FALLBACK_SECRET: firstRef,
            },
          },
        ],
      });

      try {
        const runtime = await createCnos({
          root,
          plugins: [createSecretLoader(vaultId, [firstRef])],
          processEnv: {
            CNOS_TEST_FALLBACK_SECRET: 'fallback-secret',
          },
        });

        expect(runtime.secret(firstRef)).toBe('fallback-secret');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
