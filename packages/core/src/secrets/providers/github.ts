import type { VaultDefinition } from '../../types/manifest.js';
import type { SecretVaultProvider, VaultAuthConfig } from '../types.js';

export class GithubSecretsVaultProvider implements SecretVaultProvider {
  private authenticated = false;

  constructor(
    readonly vaultId: string,
    readonly definition: VaultDefinition,
    private readonly processEnv: Record<string, string | undefined> = process.env,
  ) {}

  async authenticate(_authConfig: VaultAuthConfig): Promise<void> {
    void _authConfig;
    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private resolveEnvVar(ref: string): string | undefined {
    if (this.processEnv[ref] !== undefined) {
      return ref;
    }

    return Object.entries(this.definition.mapping ?? {}).find(([, logicalRef]) => logicalRef === ref)?.[0];
  }

  async batchGet(refs: string[]): Promise<Map<string, string>> {
    this.authenticated = true;
    const resolved = new Map<string, string>();

    for (const ref of Array.from(new Set(refs)).sort((left, right) => left.localeCompare(right))) {
      const envVar = this.resolveEnvVar(ref);
      const value = envVar ? this.processEnv[envVar] : undefined;

      if (value !== undefined) {
        resolved.set(ref, value);
      }
    }

    return resolved;
  }

  async get(ref: string): Promise<string | undefined> {
    const envVar = this.resolveEnvVar(ref);
    this.authenticated = true;
    return envVar ? this.processEnv[envVar] : undefined;
  }

  async set(ref: string, value: string): Promise<void> {
    void ref;
    void value;
    throw new Error(`Vault "${this.vaultId}" is environment-backed and cannot be written by CNOS.`);
  }

  async delete(ref: string): Promise<void> {
    void ref;
    throw new Error(`Vault "${this.vaultId}" is environment-backed and cannot be mutated by CNOS.`);
  }

  async list(): Promise<string[]> {
    return Object.values(this.definition.mapping ?? {}).sort((left, right) => left.localeCompare(right));
  }
}
