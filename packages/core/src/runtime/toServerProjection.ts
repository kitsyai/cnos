import { createHash } from 'node:crypto';

import type { ResolvedGraph, ServerProjection } from '../types/core.js';
import type { NormalizedManifest, VaultDefinition } from '../types/manifest.js';
import type { ProjectedVaultDefinition } from '../secrets/types.js';
import { isSecretReference } from '../utils/secretStore.js';

function stableSortObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function stripValuePrefix(key: string): string {
  return key.startsWith('value.') ? key.slice('value.'.length) : key;
}

function resolveProjectedEnvVar(
  manifest: NormalizedManifest,
  vaultId: string,
  ref: string,
): string | undefined {
  const mapping = manifest.vaults[vaultId]?.mapping;

  if (!mapping) {
    return undefined;
  }

  return Object.entries(mapping).find(([, logicalRef]) => logicalRef === ref)?.[0];
}

function configHash(values: Record<string, unknown>): string {
  const serialized = JSON.stringify(stableSortObject(values));
  return createHash('sha256').update(serialized).digest('hex');
}

function shouldProjectResolvedValue(sourceId: string | undefined): boolean {
  return sourceId !== 'process-env';
}

function projectVaultAuth(definition: VaultDefinition): ProjectedVaultDefinition['auth'] | undefined {
  const auth = definition.auth;

  if (!auth) {
    return undefined;
  }

  const projected = {
    ...(auth.method ? { method: auth.method } : {}),
    ...(auth.passphrase?.from
      ? {
          passphrase: {
            from: [...auth.passphrase.from],
          },
        }
      : {}),
    ...(auth.token?.from
      ? {
          token: {
            from: [...auth.token.from],
          },
        }
      : {}),
    ...(auth.config ? { config: stableSortObject(auth.config) } : {}),
  } satisfies ProjectedVaultDefinition['auth'];

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectVaultDefinition(definition: VaultDefinition): ProjectedVaultDefinition {
  const auth = projectVaultAuth(definition);
  const mapping = definition.mapping
    ? (stableSortObject(definition.mapping) as Record<string, string>)
    : undefined;

  return {
    provider: definition.provider,
    ...(auth ? { auth } : {}),
    ...(mapping && Object.keys(mapping).length > 0 ? { mapping } : {}),
  };
}

function projectReferencedVaults(
  manifest: NormalizedManifest,
  vaultIds: Set<string>,
): Record<string, ProjectedVaultDefinition> | undefined {
  const projected: Record<string, ProjectedVaultDefinition> = {};

  for (const vaultId of Array.from(vaultIds).sort((left, right) => left.localeCompare(right))) {
    const definition = manifest.vaults[vaultId];

    if (definition) {
      projected[vaultId] = projectVaultDefinition(definition);
    }
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

export function toServerProjection(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
  cnosVersion = '0.0.0-dev',
  helpers: {
    read?: (key: string) => unknown;
    isRuntimeDependent?: (key: string) => boolean;
    toServerFormula?: (key: string) => ServerProjection['derived'][string] | undefined;
  } = {},
): ServerProjection {
  const values: Record<string, unknown> = {};
  const derived: ServerProjection['derived'] = {};
  const secretRefs: ServerProjection['secretRefs'] = {};
  const referencedVaultIds = new Set<string>();
  const namespaces = new Set<string>();
  const runtimeNamespaces = new Set<string>();
  const publicKeys = Array.from(graph.entries.values())
    .filter((entry) => entry.namespace === 'public')
    .map((entry) => entry.key.slice('public.'.length))
    .sort((left, right) => left.localeCompare(right));

  for (const [key, entry] of graph.entries) {
    if (entry.namespace === 'secret' && isSecretReference(entry.value)) {
      const vaultId = entry.value.vault ?? 'default';
      const envVar = resolveProjectedEnvVar(manifest, vaultId, entry.value.ref);
      referencedVaultIds.add(vaultId);
      secretRefs[key.slice('secret.'.length)] = {
        provider: entry.value.provider,
        vault: vaultId,
        ref: entry.value.ref,
        ...(envVar
          ? {
              envVar,
            }
          : {}),
      };
      continue;
    }

    if (entry.namespace === 'value') {
      if (!shouldProjectResolvedValue(entry.winner.sourceId)) {
        continue;
      }

      if (helpers.isRuntimeDependent?.(key)) {
        const formula = helpers.toServerFormula?.(key);

        if (formula) {
          derived[stripValuePrefix(key)] = formula;
          for (const ref of formula.runtimeRefs) {
            runtimeNamespaces.add(ref.split('.')[0] ?? '');
          }
        }
        continue;
      }

      const value = helpers.read ? helpers.read(key) : entry.value;
      values[stripValuePrefix(key)] = value;
      continue;
    }

    const namespaceDefinition = manifest.namespaces[entry.namespace];

    if (
      namespaceDefinition &&
      namespaceDefinition.kind === 'data' &&
      !namespaceDefinition.sensitive &&
      entry.namespace !== 'public'
    ) {
      if (!shouldProjectResolvedValue(entry.winner.sourceId)) {
        continue;
      }

      if (helpers.isRuntimeDependent?.(key)) {
        const formula = helpers.toServerFormula?.(key);

        if (formula) {
          derived[key] = formula;
          for (const ref of formula.runtimeRefs) {
            runtimeNamespaces.add(ref.split('.')[0] ?? '');
          }
        }
        continue;
      }

      values[key] = helpers.read ? helpers.read(key) : entry.value;
      namespaces.add(entry.namespace);
    }
  }

  const vaults = projectReferencedVaults(manifest, referencedVaultIds);

  return {
    version: 1,
    workspace: graph.workspace.workspaceId,
    profile: graph.profile,
    resolvedAt: graph.resolvedAt,
    configHash: configHash(values),
    values: stableSortObject(values),
    derived: stableSortObject(derived) as ServerProjection['derived'],
    secretRefs: stableSortObject(secretRefs) as ServerProjection['secretRefs'],
    ...(vaults ? { vaults } : {}),
    publicKeys,
    runtimeNamespaces: Array.from(runtimeNamespaces).sort((left, right) => left.localeCompare(right)),
    meta: {
      workspace: graph.workspace.workspaceId,
      profile: graph.profile,
      cnos_version: cnosVersion,
      ...(namespaces.size > 0 ? { namespaces: Array.from(namespaces).sort((left, right) => left.localeCompare(right)) } : {}),
    },
  };
}
