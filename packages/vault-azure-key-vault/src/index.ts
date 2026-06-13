import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type {
  RemoteSecretVaultProvider,
  SecretVaultProviderFactory,
  VaultAuthConfig,
  VaultDefinition,
} from '@kitsy/cnos';

export const AZURE_KEY_VAULT_PROVIDER = 'azure-key-vault';

export interface AzureKeyVaultSecret {
  name?: string;
  value?: string;
}

export interface AzureKeyVaultSecretProperties {
  name: string;
}

export interface AzureKeyVaultClient {
  getSecret(name: string, options?: { version?: string }): Promise<AzureKeyVaultSecret>;
  listPropertiesOfSecrets?(): AsyncIterable<AzureKeyVaultSecretProperties>;
}

export interface AzureKeyVaultConfig {
  vaultUrl?: string;
  version?: string;
  tenantId?: string;
  clientId?: string;
}

export interface AzureKeyVaultProviderOptions {
  client?: AzureKeyVaultClient | ((vaultId: string, definition: VaultDefinition) => AzureKeyVaultClient);
}

interface AzureSecretRef {
  name: string;
  origin?: string;
  version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readConfig(definition: VaultDefinition): AzureKeyVaultConfig {
  const config = isRecord(definition.auth?.config) ? definition.auth.config : {};
  const vaultConfig: AzureKeyVaultConfig = {};
  const vaultUrl = readString(config.vaultUrl ?? config.url ?? config.endpoint);
  const version = readString(config.version);
  const tenantId = readString(config.tenantId ?? config.tenant);
  const clientId = readString(config.clientId);

  if (vaultUrl) {
    vaultConfig.vaultUrl = vaultUrl;
  }

  if (version) {
    vaultConfig.version = version;
  }

  if (tenantId) {
    vaultConfig.tenantId = tenantId;
  }

  if (clientId) {
    vaultConfig.clientId = clientId;
  }

  return vaultConfig;
}

function uniqueRefs(refs: string[]): string[] {
  return Array.from(new Set(refs)).sort((left, right) => left.localeCompare(right));
}

function parseAzureSecretUrl(ref: string): AzureSecretRef | undefined {
  try {
    const url = new URL(ref);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] !== 'secrets' || !segments[1]) {
      return undefined;
    }

    return {
      name: decodeURIComponent(segments[1]),
      origin: url.origin,
      ...(segments[2] ? { version: decodeURIComponent(segments[2]) } : {}),
    };
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return error.statusCode === 404 || error.code === 'SecretNotFound' || error.name === 'RestError' && error.statusCode === 404;
}

class AzureKeyVaultProvider implements RemoteSecretVaultProvider {
  private authenticated = false;
  private readonly config: AzureKeyVaultConfig;
  private readonly client: AzureKeyVaultClient;

  constructor(
    readonly vaultId: string,
    readonly definition: VaultDefinition,
    options: AzureKeyVaultProviderOptions = {},
  ) {
    this.config = readConfig(definition);

    if (typeof options.client === 'function') {
      this.client = options.client(vaultId, definition);
      return;
    }

    if (options.client) {
      this.client = options.client;
      return;
    }

    this.client = new SecretClient(
      this.requireVaultUrl(),
      new DefaultAzureCredential({
        ...(this.config.tenantId ? { tenantId: this.config.tenantId } : {}),
        ...(this.config.clientId ? { managedIdentityClientId: this.config.clientId } : {}),
      }),
    ) as AzureKeyVaultClient;
  }

  async authenticate(authConfig: VaultAuthConfig): Promise<void> {
    if (authConfig.method !== 'iam' && authConfig.method !== 'environment') {
      throw new Error(`Vault "${this.vaultId}" uses ${AZURE_KEY_VAULT_PROVIDER} and requires iam authentication.`);
    }

    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private requireVaultUrl(): string {
    if (!this.config.vaultUrl) {
      throw new Error(`Vault "${this.vaultId}" requires auth.config.vaultUrl for ${AZURE_KEY_VAULT_PROVIDER}.`);
    }

    return this.config.vaultUrl;
  }

  private configuredVaultOrigin(): string {
    return new URL(this.requireVaultUrl()).origin;
  }

  private externalSecretIdForRef(ref: string): string {
    return Object.entries(this.definition.mapping ?? {}).find(([, logicalRef]) => logicalRef === ref)?.[0] ?? ref;
  }

  private logicalRefForSecretName(name: string): string {
    return this.definition.mapping?.[name] ?? name;
  }

  private secretRefForLogicalRef(ref: string): AzureSecretRef {
    const external = this.externalSecretIdForRef(ref);
    const parsed = parseAzureSecretUrl(external);

    if (parsed) {
      if (parsed.origin !== this.configuredVaultOrigin()) {
        throw new Error(
          `Azure Key Vault ref "${external}" does not match configured vaultUrl "${this.requireVaultUrl()}".`,
        );
      }

      return parsed;
    }

    return {
      name: external,
      ...(this.config.version ? { version: this.config.version } : {}),
    };
  }

  private async getOne(ref: string): Promise<string | undefined> {
    const secretRef = this.secretRefForLogicalRef(ref);

    try {
      const secret = await this.client.getSecret(
        secretRef.name,
        secretRef.version ? { version: secretRef.version } : undefined,
      );

      return secret.value;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async batchGet(refs: string[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();

    await Promise.all(
      uniqueRefs(refs).map(async (ref) => {
        const value = await this.getOne(ref);

        if (value !== undefined) {
          resolved.set(ref, value);
        }
      }),
    );

    return resolved;
  }

  async get(ref: string): Promise<string | undefined> {
    return this.getOne(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    void ref;
    void value;
    throw new Error(`Vault "${this.vaultId}" is Azure Key Vault-backed and read-only.`);
  }

  async delete(ref: string): Promise<void> {
    void ref;
    throw new Error(`Vault "${this.vaultId}" is Azure Key Vault-backed and read-only.`);
  }

  async list(): Promise<string[]> {
    if (this.definition.mapping && Object.keys(this.definition.mapping).length > 0) {
      return Object.values(this.definition.mapping).sort((left, right) => left.localeCompare(right));
    }

    if (!this.client.listPropertiesOfSecrets) {
      return [];
    }

    const refs = new Set<string>();

    for await (const secret of this.client.listPropertiesOfSecrets()) {
      refs.add(this.logicalRefForSecretName(secret.name));
    }

    return Array.from(refs).sort((left, right) => left.localeCompare(right));
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      this.requireVaultUrl();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Azure Key Vault health check failed.' };
    }
  }
}

/**
 * Creates a compiled-in CNOS provider factory for Azure Key Vault.
 *
 * Authentication is delegated to Azure Identity, so production runtimes should
 * use managed identity, workload identity, environment credentials, or the
 * standard DefaultAzureCredential chain.
 */
export function createAzureKeyVaultProvider(options: AzureKeyVaultProviderOptions = {}): SecretVaultProviderFactory {
  return {
    provider: AZURE_KEY_VAULT_PROVIDER,
    create(vaultId, definition) {
      return new AzureKeyVaultProvider(vaultId, definition, options);
    },
  };
}
