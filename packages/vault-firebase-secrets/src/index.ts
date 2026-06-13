import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type {
  RemoteSecretVaultProvider,
  SecretVaultProviderFactory,
  VaultAuthConfig,
  VaultDefinition,
} from '@kitsy/cnos-core';

export const FIREBASE_SECRETS_VAULT_PROVIDER = 'firebase-secrets';

type SecretPayloadData = Buffer | Uint8Array | string | null | undefined;

interface FirebaseSecretPayload {
  data?: SecretPayloadData;
}

interface FirebaseAccessSecretVersionResponse {
  payload?: FirebaseSecretPayload | null;
}

interface FirebaseSecret {
  name?: string | null;
}

export interface FirebaseSecretsClient {
  accessSecretVersion(request: { name: string }): Promise<[FirebaseAccessSecretVersionResponse, ...unknown[]]>;
  listSecrets?(request: { parent: string }): Promise<[FirebaseSecret[], ...unknown[]]>;
  getProjectId?(): Promise<string>;
  close?(): Promise<void>;
}

export interface FirebaseSecretsVaultConfig {
  projectId?: string;
  location?: string;
  version?: string;
  endpoint?: string;
}

export interface FirebaseSecretsVaultProviderOptions {
  client?: FirebaseSecretsClient | ((vaultId: string, definition: VaultDefinition) => FirebaseSecretsClient);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readConfig(definition: VaultDefinition): FirebaseSecretsVaultConfig {
  const config = isRecord(definition.auth?.config) ? definition.auth.config : {};
  const vaultConfig: FirebaseSecretsVaultConfig = {};
  const projectId = readString(config.projectId);
  const location = readString(config.location);
  const version = readString(config.version);
  const endpoint = readString(config.endpoint ?? config.apiEndpoint);

  if (projectId) {
    vaultConfig.projectId = projectId;
  }

  if (location) {
    vaultConfig.location = location;
  }

  if (version) {
    vaultConfig.version = version;
  }

  if (endpoint) {
    vaultConfig.endpoint = endpoint;
  }

  return vaultConfig;
}

function uniqueRefs(refs: string[]): string[] {
  return Array.from(new Set(refs)).sort((left, right) => left.localeCompare(right));
}

function isFullSecretVersionName(ref: string): boolean {
  return /^projects\/[^/]+\/(?:locations\/[^/]+\/)?secrets\/[^/]+\/versions\/[^/]+$/.test(ref);
}

function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return error.code === 5 || error.code === 404 || error.status === 'NOT_FOUND';
}

function decodePayload(data: SecretPayloadData): string | undefined {
  if (data === null || data === undefined) {
    return undefined;
  }

  if (typeof data === 'string') {
    return data;
  }

  return Buffer.from(data).toString('utf8');
}

class FirebaseSecretsVaultProvider implements RemoteSecretVaultProvider {
  private authenticated = false;
  private readonly config: FirebaseSecretsVaultConfig;
  private readonly client: FirebaseSecretsClient;

  constructor(
    readonly vaultId: string,
    readonly definition: VaultDefinition,
    options: FirebaseSecretsVaultProviderOptions = {},
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

    this.client = this.config.endpoint
      ? new SecretManagerServiceClient({ apiEndpoint: this.config.endpoint })
      : new SecretManagerServiceClient();
  }

  async authenticate(authConfig: VaultAuthConfig): Promise<void> {
    if (authConfig.method !== 'iam' && authConfig.method !== 'environment') {
      throw new Error(
        `Vault "${this.vaultId}" uses ${FIREBASE_SECRETS_VAULT_PROVIDER} and requires iam authentication.`,
      );
    }

    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private async resolveProjectId(): Promise<string> {
    if (this.config.projectId) {
      return this.config.projectId;
    }

    const projectId = await this.client.getProjectId?.();
    if (projectId) {
      return projectId;
    }

    throw new Error(
      `Vault "${this.vaultId}" requires auth.config.projectId when Google ADC cannot infer a Firebase project ID.`,
    );
  }

  private externalSecretIdForRef(ref: string): string {
    return Object.entries(this.definition.mapping ?? {}).find(([, logicalRef]) => logicalRef === ref)?.[0] ?? ref;
  }

  private logicalRefForExternalSecretId(secretId: string): string {
    return this.definition.mapping?.[secretId] ?? secretId;
  }

  private async versionNameForRef(ref: string): Promise<string> {
    const secretId = this.externalSecretIdForRef(ref);

    if (isFullSecretVersionName(secretId)) {
      return secretId;
    }

    const projectId = await this.resolveProjectId();
    const version = this.config.version ?? 'latest';

    if (this.config.location) {
      return `projects/${projectId}/locations/${this.config.location}/secrets/${secretId}/versions/${version}`;
    }

    return `projects/${projectId}/secrets/${secretId}/versions/${version}`;
  }

  async batchGet(refs: string[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();

    await Promise.all(
      uniqueRefs(refs).map(async (ref) => {
        try {
          const [response] = await this.client.accessSecretVersion({
            name: await this.versionNameForRef(ref),
          });
          const value = decodePayload(response.payload?.data);

          if (value !== undefined) {
            resolved.set(ref, value);
          }
        } catch (error) {
          if (isNotFound(error)) {
            return;
          }

          throw error;
        }
      }),
    );

    return resolved;
  }

  async get(ref: string): Promise<string | undefined> {
    return (await this.batchGet([ref])).get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    void ref;
    void value;
    throw new Error(`Vault "${this.vaultId}" is Firebase Secrets-backed and read-only.`);
  }

  async delete(ref: string): Promise<void> {
    void ref;
    throw new Error(`Vault "${this.vaultId}" is Firebase Secrets-backed and read-only.`);
  }

  async list(): Promise<string[]> {
    if (!this.client.listSecrets) {
      return [];
    }

    const projectId = await this.resolveProjectId();
    const parent = this.config.location
      ? `projects/${projectId}/locations/${this.config.location}`
      : `projects/${projectId}`;
    const [secrets] = await this.client.listSecrets({ parent });

    return secrets
      .map((secret) => secret.name?.split('/secrets/')[1]?.split('/')[0])
      .filter((secretId): secretId is string => Boolean(secretId))
      .map((secretId) => this.logicalRefForExternalSecretId(secretId))
      .sort((left, right) => left.localeCompare(right));
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.resolveProjectId();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Firebase Secrets health check failed.' };
    }
  }
}

/**
 * Creates a compiled-in CNOS provider factory for Firebase Secrets.
 *
 * Firebase Secrets are stored in Google Secret Manager. Authentication is
 * delegated to Google's official client library, so production runtimes should
 * use Application Default Credentials or an attached service account.
 */
export function createFirebaseSecretsVaultProvider(
  options: FirebaseSecretsVaultProviderOptions = {},
): SecretVaultProviderFactory {
  return {
    provider: FIREBASE_SECRETS_VAULT_PROVIDER,
    create(vaultId, definition) {
      return new FirebaseSecretsVaultProvider(vaultId, definition, options);
    },
  };
}
