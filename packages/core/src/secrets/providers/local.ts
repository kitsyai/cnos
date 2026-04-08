import {
  deleteLocalSecret,
  listLocalSecrets,
  readLocalSecret,
  resolveSecretStoreRoot,
  resolveVaultAccessKey,
  resolveVaultDefinition,
  type ResolvedVaultDefinition,
  writeLocalSecret,
} from '../../utils/secretStore.js';
import { CnosAuthenticationError } from '../../errors.js';
import type { VaultDefinition } from '../../types/manifest.js';
import { appendAuditEvent } from '../auditLog.js';
import type { SecretVaultProvider, VaultAuthConfig } from '../types.js';

export class LocalSecretVaultProvider implements SecretVaultProvider {
  private authConfig?: VaultAuthConfig;

  readonly definition: VaultDefinition;

  constructor(
    readonly vaultId: string,
    definition: VaultDefinition,
    private readonly processEnv: Record<string, string | undefined> = process.env,
    private readonly storeRoot = resolveSecretStoreRoot(processEnv),
  ) {
    this.definition = definition;
  }

  static fromVaults(
    vaults: Record<string, VaultDefinition> | undefined,
    vaultId: string,
    processEnv?: Record<string, string | undefined>,
  ): LocalSecretVaultProvider {
    const definition = resolveVaultDefinition(vaults, vaultId) as ResolvedVaultDefinition;
    return new LocalSecretVaultProvider(vaultId, definition, processEnv);
  }

  async authenticate(authConfig: VaultAuthConfig): Promise<void> {
    this.authConfig = authConfig;
    await this.list();
  }

  isAuthenticated(): boolean {
    return Boolean(this.authConfig);
  }

  private async requireAuth(): Promise<VaultAuthConfig> {
    if (this.authConfig) {
      return this.authConfig;
    }

    const resolved = await resolveVaultAccessKey(this.storeRoot, this.definition, this.vaultId, this.processEnv);

    if (!resolved) {
      throw new CnosAuthenticationError(
        `Cannot authenticate to vault "${this.vaultId}". Set the configured passphrase env var or run cnos vault auth ${this.vaultId}.`,
      );
    }

    this.authConfig = resolved;
    return resolved;
  }

  async batchGet(refs: string[]): Promise<Map<string, string>> {
    const auth = await this.requireAuth();
    const entries = await Promise.all(
      Array.from(new Set(refs)).sort((left, right) => left.localeCompare(right)).map(async (ref) => [ref, await readLocalSecret(this.storeRoot, ref, auth, this.vaultId)] as const),
    );
    return new Map(entries);
  }

  async get(ref: string): Promise<string | undefined> {
    const auth = await this.requireAuth();
    try {
      return await readLocalSecret(this.storeRoot, ref, auth, this.vaultId);
    } catch {
      return undefined;
    }
  }

  async set(ref: string, value: string): Promise<void> {
    const auth = await this.requireAuth();
    await writeLocalSecret(this.storeRoot, ref, value, auth, this.vaultId);
    await appendAuditEvent(
      {
        action: 'write',
        vault: this.vaultId,
        ref,
        caller: 'cli',
      },
      this.processEnv,
    );
  }

  async delete(ref: string): Promise<void> {
    const auth = await this.requireAuth();
    await deleteLocalSecret(this.storeRoot, ref, auth, this.vaultId);
    await appendAuditEvent(
      {
        action: 'delete',
        vault: this.vaultId,
        ref,
        caller: 'cli',
      },
      this.processEnv,
    );
  }

  async list(): Promise<string[]> {
    const auth = this.authConfig ?? (await resolveVaultAccessKey(this.storeRoot, this.definition, this.vaultId, this.processEnv));

    if (!auth) {
      throw new CnosAuthenticationError(
        `Cannot authenticate to vault "${this.vaultId}". Set the configured passphrase env var or run cnos vault auth ${this.vaultId}.`,
      );
    }

    this.authConfig = auth;
    return listLocalSecrets(this.storeRoot, auth, this.vaultId);
  }
}
