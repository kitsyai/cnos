import type {
  RemoteSecretVaultProvider,
  SecretVaultProviderFactory,
  VaultAuthConfig,
  VaultDefinition,
} from '@kitsy/cnos-core';

export const HASHICORP_VAULT_PROVIDER = 'hashicorp-vault';

export interface HashicorpVaultHttpRequest {
  method?: 'GET';
  address: string;
  path: string;
  query?: Record<string, string>;
  token?: string;
  namespace?: string;
}

export interface HashicorpVaultHttpResponse {
  status: number;
  body?: unknown;
}

export interface HashicorpVaultHttpClient {
  request(request: HashicorpVaultHttpRequest): Promise<HashicorpVaultHttpResponse>;
}

export interface HashicorpVaultConfig {
  address?: string;
  mount?: string;
  namespace?: string;
  version: 1 | 2;
  path?: string;
}

export interface HashicorpVaultProviderOptions {
  client?: HashicorpVaultHttpClient | ((vaultId: string, definition: VaultDefinition) => HashicorpVaultHttpClient);
}

interface VaultReadRef {
  path: string;
  field: string;
  explicitField: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readVersion(value: unknown): 1 | 2 | undefined {
  if (value === 1 || value === '1' || value === 'kv-v1') {
    return 1;
  }

  if (value === 2 || value === '2' || value === 'kv-v2') {
    return 2;
  }

  return undefined;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function joinPath(...segments: Array<string | undefined>): string {
  return segments
    .filter((segment): segment is string => Boolean(segment))
    .map((segment) => trimSlashes(segment))
    .filter(Boolean)
    .join('/');
}

function readConfig(definition: VaultDefinition): HashicorpVaultConfig {
  const config = isRecord(definition.auth?.config) ? definition.auth.config : {};
  const vaultConfig: HashicorpVaultConfig = {
    mount: readString(config.mount) ?? 'secret',
    version: readVersion(config.version) ?? 2,
  };
  const address = readString(config.address ?? config.endpoint ?? config.url);
  const namespace = readString(config.namespace);
  const path = readString(config.path);

  if (address) {
    vaultConfig.address = address;
  }

  if (namespace) {
    vaultConfig.namespace = namespace;
  }

  if (path) {
    vaultConfig.path = path;
  }

  return vaultConfig;
}

function parseVaultRef(ref: string): VaultReadRef {
  const separator = ref.lastIndexOf('#');

  if (separator === -1) {
    return { path: ref, field: 'value', explicitField: false };
  }

  return {
    path: ref.slice(0, separator),
    field: ref.slice(separator + 1) || 'value',
    explicitField: true,
  };
}

function uniqueRefs(refs: string[]): string[] {
  return Array.from(new Set(refs)).sort((left, right) => left.localeCompare(right));
}

function decodeVaultValue(data: unknown, field: string, explicitField: boolean): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }

  const value = data[field];

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (explicitField) {
    return undefined;
  }

  const primitiveEntries = Object.values(data).filter(
    (entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
  );

  return primitiveEntries.length === 1 ? String(primitiveEntries[0]) : undefined;
}

function readKvData(body: unknown, version: 1 | 2): unknown {
  if (!isRecord(body) || !isRecord(body.data)) {
    return undefined;
  }

  return version === 2 && isRecord(body.data.data) ? body.data.data : body.data;
}

function readListKeys(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.keys)) {
    return [];
  }

  return body.data.keys.filter((key): key is string => typeof key === 'string');
}

class FetchHashicorpVaultHttpClient implements HashicorpVaultHttpClient {
  async request(request: HashicorpVaultHttpRequest): Promise<HashicorpVaultHttpResponse> {
    const url = new URL(`/v1/${trimSlashes(request.path)}`, request.address);

    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: request.method ?? 'GET',
      headers: {
        ...(request.token ? { 'X-Vault-Token': request.token } : {}),
        ...(request.namespace ? { 'X-Vault-Namespace': request.namespace } : {}),
      },
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;

    if (!response.ok && response.status !== 404) {
      throw new Error(`HashiCorp Vault request failed: ${response.status} ${response.statusText}`);
    }

    return {
      status: response.status,
      ...(body !== undefined ? { body } : {}),
    };
  }
}

class HashicorpVaultProvider implements RemoteSecretVaultProvider {
  private authenticated = false;
  private token: string | undefined;
  private readonly config: HashicorpVaultConfig;
  private readonly client: HashicorpVaultHttpClient;

  constructor(
    readonly vaultId: string,
    readonly definition: VaultDefinition,
    options: HashicorpVaultProviderOptions = {},
  ) {
    this.config = readConfig(definition);

    if (typeof options.client === 'function') {
      this.client = options.client(vaultId, definition);
      return;
    }

    this.client = options.client ?? new FetchHashicorpVaultHttpClient();
  }

  async authenticate(authConfig: VaultAuthConfig): Promise<void> {
    if (authConfig.method !== 'token' || !authConfig.token) {
      throw new Error(`Vault "${this.vaultId}" uses ${HASHICORP_VAULT_PROVIDER} and requires token authentication.`);
    }

    this.token = authConfig.token;
    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private requireAddress(): string {
    if (!this.config.address) {
      throw new Error(`Vault "${this.vaultId}" requires auth.config.address for ${HASHICORP_VAULT_PROVIDER}.`);
    }

    return this.config.address;
  }

  private externalRefForLogicalRef(ref: string): string {
    return Object.entries(this.definition.mapping ?? {}).find(([, logicalRef]) => logicalRef === ref)?.[0] ?? ref;
  }

  private logicalRefForExternalPath(path: string): string {
    return this.definition.mapping?.[`${path}#value`] ?? this.definition.mapping?.[path] ?? path;
  }

  private readPath(path: string): string {
    if (this.config.version === 2) {
      return joinPath(this.config.mount, 'data', this.config.path, path);
    }

    return joinPath(this.config.mount, this.config.path, path);
  }

  private listPath(): string {
    if (this.config.version === 2) {
      return joinPath(this.config.mount, 'metadata', this.config.path);
    }

    return joinPath(this.config.mount, this.config.path);
  }

  private async readOne(ref: string): Promise<string | undefined> {
    const external = this.externalRefForLogicalRef(ref);
    const parsed = parseVaultRef(external);
    const request: HashicorpVaultHttpRequest = {
      address: this.requireAddress(),
      path: this.readPath(parsed.path),
    };

    if (this.token) {
      request.token = this.token;
    }

    if (this.config.namespace) {
      request.namespace = this.config.namespace;
    }

    const response = await this.client.request(request);

    if (response.status === 404) {
      return undefined;
    }

    return decodeVaultValue(readKvData(response.body, this.config.version), parsed.field, parsed.explicitField);
  }

  async batchGet(refs: string[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();

    await Promise.all(
      uniqueRefs(refs).map(async (ref) => {
        const value = await this.readOne(ref);

        if (value !== undefined) {
          resolved.set(ref, value);
        }
      }),
    );

    return resolved;
  }

  async get(ref: string): Promise<string | undefined> {
    return this.readOne(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    void ref;
    void value;
    throw new Error(`Vault "${this.vaultId}" is HashiCorp Vault-backed and read-only.`);
  }

  async delete(ref: string): Promise<void> {
    void ref;
    throw new Error(`Vault "${this.vaultId}" is HashiCorp Vault-backed and read-only.`);
  }

  async list(): Promise<string[]> {
    if (this.definition.mapping && Object.keys(this.definition.mapping).length > 0) {
      return Object.values(this.definition.mapping).sort((left, right) => left.localeCompare(right));
    }

    const request: HashicorpVaultHttpRequest = {
      address: this.requireAddress(),
      path: this.listPath(),
      query: { list: 'true' },
    };

    if (this.token) {
      request.token = this.token;
    }

    if (this.config.namespace) {
      request.namespace = this.config.namespace;
    }

    const response = await this.client.request(request);

    if (response.status === 404) {
      return [];
    }

    return readListKeys(response.body)
      .filter((key) => !key.endsWith('/'))
      .map((key) => this.logicalRefForExternalPath(key))
      .sort((left, right) => left.localeCompare(right));
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const request: HashicorpVaultHttpRequest = {
        address: this.requireAddress(),
        path: 'sys/health',
      };

      if (this.token) {
        request.token = this.token;
      }

      if (this.config.namespace) {
        request.namespace = this.config.namespace;
      }

      const response = await this.client.request(request);

      return { ok: response.status < 500 };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'HashiCorp Vault health check failed.' };
    }
  }
}

/**
 * Creates a compiled-in CNOS provider factory for HashiCorp Vault.
 *
 * CNOS resolves token sources such as `env:VAULT_TOKEN`, `file:...`, or
 * `keychain:...`; this provider sends the resolved token to Vault's HTTP API.
 */
export function createHashicorpVaultProvider(options: HashicorpVaultProviderOptions = {}): SecretVaultProviderFactory {
  return {
    provider: HASHICORP_VAULT_PROVIDER,
    create(vaultId, definition) {
      return new HashicorpVaultProvider(vaultId, definition, options);
    },
  };
}
