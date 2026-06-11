import type { ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import { appendAuditEvent } from './auditLog.js';
import { SecretCache } from './secretCache.js';
import type { SecretDescriptor, SecretReference, SecretVaultProviderFactory } from './types.js';
import { createSecretVaultProvider } from './providers/registry.js';
import { isSecretReference } from '../utils/secretStore.js';
import { resolveVaultAuth } from './resolveAuth.js';

function collectSecretDescriptors(graph: ResolvedGraph): SecretDescriptor[] {
  return Array.from(graph.entries.values())
    .filter((entry) => entry.namespace === 'secret' && isSecretReference(entry.value))
    .map((entry) => ({
      logicalKey: entry.key,
      ref: entry.value as SecretReference,
    }));
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
    const vaultId = descriptor.ref.vault ?? 'default';
    const bucket = accumulator.get(vaultId) ?? [];
    bucket.push(descriptor);
    accumulator.set(vaultId, bucket);
    return accumulator;
  }, new Map());

  for (const [vaultId, refs] of grouped) {
    const definition = manifest.vaults[vaultId] ?? { provider: 'local', auth: { passphrase: { from: [] } } };
    const provider = createSecretVaultProvider(vaultId, definition, processEnv, factories);
    const auth = await resolveVaultAuth(vaultId, definition, processEnv);
    await provider.authenticate(auth);
    const resolved = await provider.batchGet(refs.map((entry) => entry.ref.ref));
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
