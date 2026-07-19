import { createHash } from 'node:crypto';

import type { ResolvedGraph, ServerProjection } from '../types/core.js';
import type { NormalizedManifest, VaultDefinition } from '../types/manifest.js';
import type { ProjectedVaultDefinition } from '../secrets/types.js';
import type { OverrideSpec, OverridePrioritySource } from '../types/spec.js';
import type {
  DocumentSchemaDefinition,
  ProjectedVarSourceDefinition,
  VarGroupDefinition,
} from '../types/var.js';
import { assertSecretRefVaultProviderCompatible } from '../secrets/providerCompatibility.js';
import { isSecretReference } from '../utils/secretStore.js';

const DEFAULT_OVERRIDE_PRIORITY: OverridePrioritySource[] = ['arg', 'env', 'cnos'];

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

const SAFE_PROJECTED_CONFIG_KEYS = new Set([
  'address',
  'audience',
  'clientid',
  'endpoint',
  'mount',
  'namespace',
  'path',
  'projectid',
  'region',
  'scope',
  'scopes',
  'serviceaccountemail',
  'tenant',
  'tenantid',
  'url',
  'version',
  'vaulturl',
]);

function isSafeProjectedConfigKey(key: string): boolean {
  return SAFE_PROJECTED_CONFIG_KEYS.has(key.replace(/[^A-Za-z0-9]/g, '').toLowerCase());
}

function sanitizeProjectedConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProjectedConfigValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return stableSortObject(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, sanitizeProjectedConfigValue(item)] as const)
        .filter(([key, item]) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return Object.keys(item as Record<string, unknown>).length > 0;
          }

          return isSafeProjectedConfigKey(key);
        }),
    ),
  );
}

function sanitizeProjectedConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const sanitized = sanitizeProjectedConfigValue(config);

  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return undefined;
  }

  return Object.keys(sanitized).length > 0 ? (sanitized as Record<string, unknown>) : undefined;
}

function projectVaultAuth(definition: VaultDefinition): ProjectedVaultDefinition['auth'] | undefined {
  const auth = definition.auth;

  if (!auth) {
    return undefined;
  }

  const config = auth.config ? sanitizeProjectedConfig(auth.config) : undefined;

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
    ...(config ? { config } : {}),
  } satisfies ProjectedVaultDefinition['auth'];

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectVaultDefinition(definition: VaultDefinition): ProjectedVaultDefinition {
  const auth = projectVaultAuth(definition);
  const mapping = definition.mapping
    ? (stableSortObject(definition.mapping) as Record<string, string>)
    : undefined;
  const fallback = definition.fallback?.map((entry) => projectVaultDefinition({
    provider: entry.provider,
    ...(entry.auth ? { auth: entry.auth } : {}),
    ...(entry.mapping ? { mapping: entry.mapping } : {}),
  }));

  return {
    provider: definition.provider,
    ...(auth ? { auth } : {}),
    ...(mapping && Object.keys(mapping).length > 0 ? { mapping } : {}),
    ...(fallback && fallback.length > 0 ? { fallback } : {}),
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

function projectVarSources(
  manifest: NormalizedManifest,
): Record<string, ProjectedVarSourceDefinition> | undefined {
  const sources = manifest.varSources ?? {};

  if (Object.keys(sources).length === 0) {
    return undefined;
  }

  // Refs only: auth/verify values are secret.* references, never resolved material.
  return stableSortObject(
    Object.fromEntries(
      Object.entries(sources).map(([name, source]) => [
        name,
        {
          transport: source.transport,
          url: source.url,
          auth: stableSortObject(source.auth) as Record<string, string>,
          ...(source.pollInterval ? { pollInterval: source.pollInterval } : {}),
          ...(source.verify ? { verify: source.verify } : {}),
        } satisfies ProjectedVarSourceDefinition,
      ]),
    ),
  ) as Record<string, ProjectedVarSourceDefinition>;
}

function projectVars(
  manifest: NormalizedManifest,
): Record<string, VarGroupDefinition> | undefined {
  const vars = manifest.vars ?? {};

  if (Object.keys(vars).length === 0) {
    return undefined;
  }

  return stableSortObject(vars) as Record<string, VarGroupDefinition>;
}

function projectDocuments(
  manifest: NormalizedManifest,
): Record<string, DocumentSchemaDefinition> | undefined {
  const documents = manifest.documents ?? {};

  if (Object.keys(documents).length === 0) {
    return undefined;
  }

  return stableSortObject(documents) as Record<string, DocumentSchemaDefinition>;
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
  options: {
    /** Include all schema-declared keys in the overrides block, not just those with env/arg aliases.
     *  Enables patch-file-only workflows to carry schema type metadata at runtime. */
    dynamic?: boolean;
  } = {},
): ServerProjection {
  const values: Record<string, unknown> = {};
  const derived: ServerProjection['derived'] = {};
  const secretRefs: ServerProjection['secretRefs'] = {};
  const valueTypes: Record<string, string> = {};
  const overrides: Record<string, OverrideSpec> = {};
  const referencedVaultIds = new Set<string>();
  const namespaces = new Set<string>();
  const runtimeNamespaces = new Set<string>();
  const publicKeys = Array.from(graph.entries.values())
    .filter((entry) => entry.namespace === 'public')
    .map((entry) => entry.key.slice('public.'.length))
    .sort((left, right) => left.localeCompare(right));

  for (const [key, entry] of graph.entries) {
    if (entry.namespace === 'secret' && isSecretReference(entry.value)) {
      assertSecretRefVaultProviderCompatible(manifest, entry.value, key);
      const vaultId = entry.value.vault ?? 'default';
      const provider = entry.value.provider ?? manifest.vaults[vaultId]?.provider ?? 'local';
      const envVar = resolveProjectedEnvVar(manifest, vaultId, entry.value.ref);
      referencedVaultIds.add(vaultId);
      secretRefs[key.slice('secret.'.length)] = {
        provider,
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
      const strippedKey = stripValuePrefix(key);
      values[strippedKey] = value;
      const schemaRule = manifest.schema[key] ?? manifest.schema[strippedKey];
      if (schemaRule?.format) {
        valueTypes[strippedKey] = schemaRule.format;
      }
      const envAliases = schemaRule?.env ? (Array.isArray(schemaRule.env) ? schemaRule.env : [schemaRule.env]) : [];
      const argAliases = schemaRule?.arg ? (Array.isArray(schemaRule.arg) ? schemaRule.arg : [schemaRule.arg]) : [];
      if (envAliases.length > 0 || argAliases.length > 0) {
        overrides[strippedKey] = {
          env: envAliases,
          arg: argAliases,
          priority: schemaRule?.priority ?? DEFAULT_OVERRIDE_PRIORITY,
          ...(schemaRule?.type ? { type: schemaRule.type } : {}),
        };
      }
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

  // Second pass: schema keys that declare env/arg but had no stored value in the graph.
  // This ensures the overrides block is complete even for keys with no resolved value
  // (e.g. a key whose value will be supplied entirely via env var or CLI arg at runtime).
  for (const [schemaKey, schemaRule] of Object.entries(manifest.schema)) {
    if (!schemaRule?.env && !schemaRule?.arg) continue;
    const strippedKey = stripValuePrefix(schemaKey);
    if (overrides[strippedKey]) continue;
    const envAliases = schemaRule.env ? (Array.isArray(schemaRule.env) ? schemaRule.env : [schemaRule.env]) : [];
    const argAliases = schemaRule.arg ? (Array.isArray(schemaRule.arg) ? schemaRule.arg : [schemaRule.arg]) : [];
    if (envAliases.length > 0 || argAliases.length > 0) {
      overrides[strippedKey] = {
        env: envAliases,
        arg: argAliases,
        priority: schemaRule.priority ?? DEFAULT_OVERRIDE_PRIORITY,
        ...(schemaRule.type ? { type: schemaRule.type } : {}),
      };
    }
  }

  // Third pass (dynamic mode only): remaining schema keys with no env/arg — emit a cnos-priority
  // override entry so their declared type travels with the projection for patch-file workflows.
  if (options.dynamic) {
    for (const [schemaKey, schemaRule] of Object.entries(manifest.schema)) {
      const strippedKey = stripValuePrefix(schemaKey);
      if (overrides[strippedKey]) continue;
      overrides[strippedKey] = {
        env: [],
        arg: [],
        priority: ['cnos'],
        ...(schemaRule?.type ? { type: schemaRule.type } : {}),
      };
    }
  }

  const vaults = projectReferencedVaults(manifest, referencedVaultIds);
  const varSources = projectVarSources(manifest);
  const vars = projectVars(manifest);
  const documents = projectDocuments(manifest);

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
    ...(varSources ? { varSources } : {}),
    ...(vars ? { vars } : {}),
    ...(documents ? { documents } : {}),
    publicKeys,
    runtimeNamespaces: Array.from(runtimeNamespaces).sort((left, right) => left.localeCompare(right)),
    ...(Object.keys(valueTypes).length > 0 ? { valueTypes: stableSortObject(valueTypes) as Record<string, string> } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides: stableSortObject(overrides) as Record<string, OverrideSpec> } : {}),
    meta: {
      workspace: graph.workspace.workspaceId,
      profile: graph.profile,
      cnos_version: cnosVersion,
      ...(namespaces.size > 0 ? { namespaces: Array.from(namespaces).sort((left, right) => left.localeCompare(right)) } : {}),
    },
  };
}
