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
import { describe, expect, it } from 'vitest';

export interface SecretVaultProviderConformanceSetup {
  factory: SecretVaultProviderFactory;
  definition: VaultDefinition;
  auth: VaultAuthConfig;
  refs: Record<string, string>;
  missingRef?: string;
  processEnv?: Record<string, string | undefined>;
}

export interface SecretVaultRuntimeConformanceSetup {
  factory: SecretVaultProviderFactory;
  vaultId: string;
  definition: VaultDefinition;
  refs: Record<string, string>;
  processEnv?: Record<string, string | undefined>;
  afterReads?: () => void;
}

function createSecretLoader(vaultId: string, provider: string, refs: string[]): LoaderPlugin {
  return {
    id: 'test-remote-secret-loader',
    kind: 'loader',
    async load() {
      return refs.map((ref) => ({
        key: `secret.${ref}`,
        value: {
          provider,
          vault: vaultId,
          ref,
        },
        namespace: 'secret',
        sourceId: 'filesystem-secrets',
        pluginId: '@kitsy/cnos/plugins/filesystem-secrets',
        workspaceId: 'default',
      }) satisfies ConfigEntry);
    },
  };
}

function buildAuthLines(definition: VaultDefinition): string[] {
  if (!definition.auth) {
    return [];
  }

  return [
    '    auth:',
    ...(definition.auth.method ? [`      method: ${definition.auth.method}`] : []),
    ...(definition.auth.passphrase?.from
      ? [
          '      passphrase:',
          '        from:',
          ...definition.auth.passphrase.from.map((source) => `          - ${source}`),
        ]
      : []),
    ...(definition.auth.token?.from
      ? [
          '      token:',
          '        from:',
          ...definition.auth.token.from.map((source) => `          - ${source}`),
        ]
      : []),
  ];
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
      ...buildAuthLines(definition),
    ].join('\n'),
  );
  return root;
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

    it('supports get, list, and read-only mutation errors', async () => {
      const { factory, definition, auth, refs, missingRef = 'missing.ref', processEnv } = setup();
      const provider = factory.create('conformance', definition, processEnv);
      await provider.authenticate(auth);
      const [firstRef] = Object.keys(refs);

      if (!firstRef) {
        throw new Error('Provider conformance requires at least one ref fixture.');
      }

      await expect(provider.get(firstRef)).resolves.toBe(refs[firstRef]);
      await expect(provider.get(missingRef)).resolves.toBeUndefined();
      await expect(provider.list()).resolves.toEqual(Object.keys(refs).sort((left, right) => left.localeCompare(right)));
      await expect(provider.set(firstRef, 'updated')).rejects.toThrow('read-only');
      await expect(provider.delete(firstRef)).rejects.toThrow('read-only');
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
      const { factory, vaultId, definition, refs, processEnv, afterReads } = setup();
      const root = await createManifestRoot(vaultId, definition);

      try {
        const runtime = await createCnos({
          root,
          plugins: [createSecretLoader(vaultId, definition.provider, Object.keys(refs))],
          secretVaultProviders: [factory],
          ...(processEnv ? { processEnv } : {}),
        });

        for (const [ref, value] of Object.entries(refs)) {
          expect(runtime.secret(ref)).toBe(value);
          expect(runtime.secret(ref)).toBe(value);
        }

        afterReads?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
