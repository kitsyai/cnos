import type { VaultDefinition } from '../types/manifest.js';

export interface SecretReference {
  provider: string;
  ref: string;
  vault?: string;
}

/** Auth metadata safe to serialize into server projections. */
export interface ProjectedVaultAuthDefinition {
  method?: VaultAuthConfig['method'];
  passphrase?: {
    from: string[];
  };
  token?: {
    from: string[];
  };
  config?: Record<string, unknown>;
}

/** Vault metadata required by runtimes to hydrate projected secret refs. */
export interface ProjectedVaultDefinition {
  provider: string;
  auth?: ProjectedVaultAuthDefinition;
  mapping?: Record<string, string>;
}

export interface VaultAuthConfig {
  passphrase?: string;
  token?: string;
  derivedKey?: Buffer;
  method: 'passphrase' | 'environment' | 'token' | 'iam' | 'keychain';
  config?: Record<string, unknown>;
}

export interface SecretVaultProvider {
  readonly vaultId: string;
  readonly definition: VaultDefinition;
  authenticate(authConfig: VaultAuthConfig): Promise<void>;
  isAuthenticated(): boolean;
  batchGet(refs: string[]): Promise<Map<string, string>>;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Factory used by runtimes and provider packages to construct vault clients. */
export interface SecretVaultProviderFactory {
  readonly provider: string;
  create(
    vaultId: string,
    definition: VaultDefinition,
    processEnv?: Record<string, string | undefined>,
  ): SecretVaultProvider;
}

export interface RemoteSecretVaultProvider extends SecretVaultProvider {
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

export interface SecretDescriptor {
  logicalKey: string;
  ref: SecretReference;
}
