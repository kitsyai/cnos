import type { VaultDefinition } from '../types/manifest.js';

export interface SecretReference {
  provider: string;
  ref: string;
  vault?: string;
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

export interface RemoteSecretVaultProvider extends SecretVaultProvider {
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

export interface SecretDescriptor {
  logicalKey: string;
  ref: SecretReference;
}
