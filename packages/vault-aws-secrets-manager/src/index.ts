import {
  BatchGetSecretValueCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type {
  RemoteSecretVaultProvider,
  SecretVaultProviderFactory,
  VaultAuthConfig,
  VaultDefinition,
} from '@kitsy/cnos';

export const AWS_SECRETS_MANAGER_VAULT_PROVIDER = 'aws-secrets-manager';

interface AwsSecretsManagerCommand {
  readonly input?: unknown;
}

export interface AwsSecretsManagerClient {
  send(command: AwsSecretsManagerCommand): Promise<unknown>;
}

export interface AwsSecretsManagerVaultConfig {
  region?: string;
  endpoint?: string;
  versionId?: string;
  versionStage?: string;
}

export interface AwsSecretsManagerVaultProviderOptions {
  client?: AwsSecretsManagerClient | ((vaultId: string, definition: VaultDefinition) => AwsSecretsManagerClient);
}

interface AwsSecretValue {
  Name?: string;
  ARN?: string;
  SecretString?: string;
  SecretBinary?: Uint8Array | string;
}

interface AwsBatchGetSecretValueOutput {
  SecretValues?: AwsSecretValue[];
  Errors?: AwsBatchGetSecretValueError[];
}

interface AwsBatchGetSecretValueError {
  ErrorCode?: string;
  Message?: string;
  SecretId?: string;
}

type AwsGetSecretValueOutput = AwsSecretValue;

interface AwsListSecretsOutput {
  SecretList?: Array<{ Name?: string; ARN?: string }>;
  NextToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readConfig(definition: VaultDefinition): AwsSecretsManagerVaultConfig {
  const config = isRecord(definition.auth?.config) ? definition.auth.config : {};
  const vaultConfig: AwsSecretsManagerVaultConfig = {};
  const region = readString(config.region);
  const endpoint = readString(config.endpoint);
  const versionId = readString(config.versionId ?? config.version);
  const versionStage = readString(config.versionStage);

  if (region) {
    vaultConfig.region = region;
  }

  if (endpoint) {
    vaultConfig.endpoint = endpoint;
  }

  if (versionId) {
    vaultConfig.versionId = versionId;
  }

  if (versionStage) {
    vaultConfig.versionStage = versionStage;
  }

  return vaultConfig;
}

function uniqueRefs(refs: string[]): string[] {
  return Array.from(new Set(refs)).sort((left, right) => left.localeCompare(right));
}

function decodeSecretValue(secret: AwsSecretValue): string | undefined {
  if (secret.SecretString !== undefined) {
    return secret.SecretString;
  }

  if (secret.SecretBinary !== undefined) {
    return Buffer.from(secret.SecretBinary).toString('utf8');
  }

  return undefined;
}

function isResourceNotFound(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return error.name === 'ResourceNotFoundException' || error.Code === 'ResourceNotFoundException';
}

function isResourceNotFoundCode(errorCode: string | undefined): boolean {
  return errorCode === 'ResourceNotFoundException';
}

class AwsSecretsManagerVaultProvider implements RemoteSecretVaultProvider {
  private authenticated = false;
  private readonly config: AwsSecretsManagerVaultConfig;
  private readonly client: AwsSecretsManagerClient;

  constructor(
    readonly vaultId: string,
    readonly definition: VaultDefinition,
    options: AwsSecretsManagerVaultProviderOptions = {},
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

    this.client = new SecretsManagerClient({
      ...(this.config.region ? { region: this.config.region } : {}),
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
    }) as AwsSecretsManagerClient;
  }

  async authenticate(authConfig: VaultAuthConfig): Promise<void> {
    if (authConfig.method !== 'iam' && authConfig.method !== 'environment') {
      throw new Error(
        `Vault "${this.vaultId}" uses ${AWS_SECRETS_MANAGER_VAULT_PROVIDER} and requires iam authentication.`,
      );
    }

    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private externalSecretIdForRef(ref: string): string {
    return Object.entries(this.definition.mapping ?? {}).find(([, logicalRef]) => logicalRef === ref)?.[0] ?? ref;
  }

  private logicalRefForExternalSecretId(secretId: string): string {
    return this.definition.mapping?.[secretId] ?? secretId;
  }

  private secretValueRequest(ref: string): { SecretId: string; VersionId?: string; VersionStage?: string } {
    const request: { SecretId: string; VersionId?: string; VersionStage?: string } = {
      SecretId: this.externalSecretIdForRef(ref),
    };

    if (this.config.versionId) {
      request.VersionId = this.config.versionId;
    }

    if (this.config.versionStage) {
      request.VersionStage = this.config.versionStage;
    }

    return request;
  }

  private resolveOutputRef(secret: AwsSecretValue, requestedRefs: Map<string, string>): string | undefined {
    if (secret.ARN) {
      const arnRef = requestedRefs.get(secret.ARN);

      if (arnRef) {
        return arnRef;
      }
    }

    if (secret.Name) {
      return requestedRefs.get(secret.Name) ?? this.logicalRefForExternalSecretId(secret.Name);
    }

    return undefined;
  }

  private assertBatchErrors(output: AwsBatchGetSecretValueOutput): void {
    for (const error of output.Errors ?? []) {
      if (isResourceNotFoundCode(error.ErrorCode)) {
        continue;
      }

      throw new Error(
        `AWS Secrets Manager batch read failed for "${error.SecretId ?? 'unknown'}": ${
          error.ErrorCode ?? 'UnknownError'
        }${error.Message ? `: ${error.Message}` : ''}`,
      );
    }
  }

  private async getOne(ref: string): Promise<string | undefined> {
    try {
      const response = await this.client.send(new GetSecretValueCommand(this.secretValueRequest(ref)));
      return decodeSecretValue(response as AwsGetSecretValueOutput);
    } catch (error) {
      if (isResourceNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async batchGet(refs: string[]): Promise<Map<string, string>> {
    const requestedRefs = uniqueRefs(refs);
    const resolved = new Map<string, string>();
    const externalToLogical = new Map(requestedRefs.map((ref) => [this.externalSecretIdForRef(ref), ref]));

    if (this.config.versionId || this.config.versionStage) {
      await Promise.all(
        requestedRefs.map(async (ref) => {
          const value = await this.getOne(ref);

          if (value !== undefined) {
            resolved.set(ref, value);
          }
        }),
      );

      return resolved;
    }

    try {
      const response = await this.client.send(new BatchGetSecretValueCommand({
        SecretIdList: requestedRefs.map((ref) => this.externalSecretIdForRef(ref)),
      }));

      const output = response as AwsBatchGetSecretValueOutput;
      this.assertBatchErrors(output);

      for (const secret of output.SecretValues ?? []) {
        const ref = this.resolveOutputRef(secret, externalToLogical);
        const value = decodeSecretValue(secret);

        if (ref && value !== undefined) {
          resolved.set(ref, value);
        }
      }

      return resolved;
    } catch (error) {
      if (!isResourceNotFound(error)) {
        throw error;
      }
    }

    await Promise.all(
      requestedRefs.map(async (ref) => {
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
    throw new Error(`Vault "${this.vaultId}" is AWS Secrets Manager-backed and read-only.`);
  }

  async delete(ref: string): Promise<void> {
    void ref;
    throw new Error(`Vault "${this.vaultId}" is AWS Secrets Manager-backed and read-only.`);
  }

  async list(): Promise<string[]> {
    const secretIds = new Set<string>();
    let nextToken: string | undefined;

    do {
      const response = await this.client.send(new ListSecretsCommand({
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      const output = response as AwsListSecretsOutput;

      for (const secret of output.SecretList ?? []) {
        const secretId = secret.Name ?? secret.ARN;

        if (secretId) {
          secretIds.add(secretId);
        }
      }

      nextToken = output.NextToken;
    } while (nextToken);

    return Array.from(secretIds)
      .map((secretId) => this.logicalRefForExternalSecretId(secretId))
      .sort((left, right) => left.localeCompare(right));
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}

/**
 * Creates a compiled-in CNOS provider factory for AWS Secrets Manager.
 *
 * Authentication is delegated to AWS SDK v3, so production runtimes should use
 * IAM roles, web identity, environment credentials, or the standard AWS provider chain.
 */
export function createAwsSecretsManagerVaultProvider(
  options: AwsSecretsManagerVaultProviderOptions = {},
): SecretVaultProviderFactory {
  return {
    provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
    create(vaultId, definition) {
      return new AwsSecretsManagerVaultProvider(vaultId, definition, options);
    },
  };
}
