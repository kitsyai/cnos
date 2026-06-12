import type { ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest, VaultDefinition, VaultFallbackDefinition } from '../types/manifest.js';
import { appendAuditEvent } from './auditLog.js';
import { SecretCache } from './secretCache.js';
import type { SecretDescriptor, SecretReference, SecretVaultProviderFactory } from './types.js';
import { createSecretVaultProvider } from './providers/registry.js';
import { isSecretReference } from '../utils/secretStore.js';
import { assertSecretRefVaultProviderCompatible } from './providerCompatibility.js';
import { resolveVaultAuth } from './resolveAuth.js';

function collectSecretDescriptors(graph: ResolvedGraph): SecretDescriptor[] {
  return Array.from(graph.entries.values())
    .filter((entry) => entry.namespace === 'secret' && isSecretReference(entry.value))
    .map((entry) => ({
      logicalKey: entry.key,
      ref: entry.value as SecretReference,
    }));
}

function secretGroupKey(manifest: NormalizedManifest, descriptor: SecretDescriptor): string {
  assertSecretRefVaultProviderCompatible(manifest, descriptor.ref, descriptor.logicalKey);
  const vaultId = descriptor.ref.vault ?? 'default';
  const provider = descriptor.ref.provider ?? manifest.vaults[vaultId]?.provider ?? 'local';
  return `${vaultId}\0${provider}`;
}

function vaultDefinitionForRef(
  manifest: NormalizedManifest,
  ref: SecretReference,
): VaultDefinition {
  assertSecretRefVaultProviderCompatible(manifest, ref);
  const vaultId = ref.vault ?? 'default';
  const base = manifest.vaults[vaultId] ?? { provider: 'local', auth: { passphrase: { from: [] } } };

  if (!ref.provider || ref.provider === base.provider) {
    return base;
  }

  return {
    ...base,
    provider: ref.provider,
  };
}

async function resolveFromDefinition(
  vaultId: string,
  definition: VaultDefinition | VaultFallbackDefinition,
  refs: SecretDescriptor[],
  processEnv: Record<string, string | undefined>,
  factories: SecretVaultProviderFactory[],
): Promise<Map<string, string>> {
  const runtimeDefinition: VaultDefinition = {
    provider: definition.provider,
    ...(definition.auth ? { auth: definition.auth } : {}),
    ...(definition.mapping ? { mapping: definition.mapping } : {}),
  };
  const provider = createSecretVaultProvider(vaultId, runtimeDefinition, processEnv, factories);
  const auth = await resolveVaultAuth(vaultId, runtimeDefinition, processEnv);
  await provider.authenticate(auth);
  return provider.batchGet(refs.map((entry) => entry.ref.ref));
}

export async function batchResolveSecrets(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
  processEnv: Record<string, string | undefined> = process.env,
  factories: SecretVaultProviderFactory[] = [],
): Promise<SecretCache> {
  const cache = new SecretCache();
  const descriptors = collectSecretDescriptors(graph);
  const grouped = descriptors.reduce<Map<string, SecretDescriptor[]>>((accumulator, descriptor) => {
    const key = secretGroupKey(manifest, descriptor);
    const bucket = accumulator.get(key) ?? [];
    bucket.push(descriptor);
    accumulator.set(key, bucket);
    return accumulator;
  }, new Map());

  for (const refs of grouped.values()) {
    const first = refs[0];
    if (!first) {
      continue;
    }
    const vaultId = first.ref.vault ?? 'default';
    const definition = vaultDefinitionForRef(manifest, first.ref);
    const definitions = [definition, ...(definition.fallback ?? [])];
    const resolved = new Map<string, string>();
    let remaining = refs;
    let lastError: unknown;

    for (const candidate of definitions) {
      try {
        const candidateValues = await resolveFromDefinition(vaultId, candidate, remaining, processEnv, factories);

        for (const descriptor of remaining) {
          const value = candidateValues.get(descriptor.ref.ref);

          if (value !== undefined) {
            resolved.set(descriptor.ref.ref, value);
          }
        }

        remaining = remaining.filter((descriptor) => !resolved.has(descriptor.ref.ref));

        if (remaining.length === 0) {
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (resolved.size === 0 && lastError) {
      throw lastError;
    }

    cache.load(vaultId, resolved);
    await appendAuditEvent(
      {
        action: 'batch_read',
        vault: vaultId,
        refs: Array.from(resolved.keys()).sort((left, right) => left.localeCompare(right)),
        caller: 'runtime',
        workspace: graph.workspace.workspaceId,
        profile: graph.profile,
      },
      processEnv,
    );
  }

  return cache;
}

export function resolveSecretEntryValue(
  key: string,
  value: unknown,
  cache: SecretCache,
): unknown {
  if (!key.startsWith('secret.') || !isSecretReference(value)) {
    return value;
  }

  const vaultId = value.vault ?? 'default';
  return cache.get(vaultId, value.ref) ?? value;
}
