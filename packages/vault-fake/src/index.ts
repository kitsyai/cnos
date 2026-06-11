import type {
  RemoteSecretVaultProvider,
  SecretVaultProviderFactory,
  VaultAuthConfig,
  VaultDefinition,
} from '@kitsy/cnos-core';

export const FAKE_REMOTE_VAULT_PROVIDER = 'fake-remote';

export interface FakeRemoteVaultCalls {
  authenticate: VaultAuthConfig[];
  batchGet: string[][];
  get: string[];
  set: Array<{ ref: string; value: string }>;
  delete: string[];
  list: number;
  healthCheck: number;
}

export interface FakeRemoteVaultOptions {
  secrets: Record<string, string>;
  calls?: FakeRemoteVaultCalls;
  failAuth?: boolean;
  health?: { ok: boolean; message?: string };
}

export function createFakeRemoteVaultCalls(): FakeRemoteVaultCalls {
  return {
    authenticate: [],
    batchGet: [],
    get: [],
    set: [],
    delete: [],
    list: 0,
    healthCheck: 0,
  };
}

class FakeRemoteVaultProvider implements RemoteSecretVaultProvider {
  private authenticated = false;

  constructor(
    readonly vaultId: string,
    readonly definition: VaultDefinition,
    private readonly options: Required<Pick<FakeRemoteVaultOptions, 'calls' | 'secrets'>> &
      Pick<FakeRemoteVaultOptions, 'failAuth' | 'health'>,
  ) {}

  async authenticate(authConfig: VaultAuthConfig): Promise<void> {
    this.options.calls.authenticate.push(authConfig);

    if (this.options.failAuth) {
      throw new Error(`Vault "${this.vaultId}" failed fake remote authentication.`);
    }

    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async batchGet(refs: string[]): Promise<Map<string, string>> {
    this.options.calls.batchGet.push([...refs]);
    const resolved = new Map<string, string>();

    for (const ref of Array.from(new Set(refs)).sort((left, right) => left.localeCompare(right))) {
      const value = this.options.secrets[ref];

      if (value !== undefined) {
        resolved.set(ref, value);
      }
    }

    return resolved;
  }

  async get(ref: string): Promise<string | undefined> {
    this.options.calls.get.push(ref);
    return this.options.secrets[ref];
  }

  async set(ref: string, value: string): Promise<void> {
    this.options.calls.set.push({ ref, value });
    throw new Error(`Vault "${this.vaultId}" is fake-remote-backed and read-only.`);
  }

  async delete(ref: string): Promise<void> {
    this.options.calls.delete.push(ref);
    throw new Error(`Vault "${this.vaultId}" is fake-remote-backed and read-only.`);
  }

  async list(): Promise<string[]> {
    this.options.calls.list += 1;
    return Object.keys(this.options.secrets).sort((left, right) => left.localeCompare(right));
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    this.options.calls.healthCheck += 1;
    return this.options.health ?? { ok: true };
  }
}

export function createFakeRemoteVaultProvider(
  options: FakeRemoteVaultOptions,
): SecretVaultProviderFactory {
  const calls = options.calls ?? createFakeRemoteVaultCalls();

  return {
    provider: FAKE_REMOTE_VAULT_PROVIDER,
    create(vaultId, definition) {
      return new FakeRemoteVaultProvider(vaultId, definition, {
        secrets: options.secrets,
        calls,
        ...(options.failAuth !== undefined ? { failAuth: options.failAuth } : {}),
        ...(options.health ? { health: options.health } : {}),
      });
    },
  };
}
