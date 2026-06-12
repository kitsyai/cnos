import {
  defineSecretVaultProviderConformanceSuite,
  defineSecretVaultRuntimeConformanceSuite,
} from '@kitsy/cnos-vault-testkit';
import { describe, expect, it } from 'vitest';

import {
  AWS_SECRETS_MANAGER_VAULT_PROVIDER,
  type AwsSecretsManagerClient,
  createAwsSecretsManagerVaultProvider,
} from '../src/index.js';

const region = 'us-east-1';
const secrets = {
  'app.token': 'aws-token',
  'db.password': 'aws-password',
};
const arnSecretValue = 'arn-secret';
const directArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:direct/arn-AbCdEf';
const mapping = {
  'app/token': 'app.token',
  'db/password': 'db.password',
};

interface AwsSecretsManagerCalls {
  batchGetSecretValue: Array<Record<string, unknown>>;
  getSecretValue: Array<Record<string, unknown>>;
  listSecrets: Array<Record<string, unknown>>;
}

interface AwsClientOptions {
  batchErrors?: Array<{ ErrorCode: string; Message?: string; SecretId?: string }>;
  paginatedList?: boolean;
}

function createCalls(): AwsSecretsManagerCalls {
  return {
    batchGetSecretValue: [],
    getSecretValue: [],
    listSecrets: [],
  };
}

function commandName(command: unknown): string {
  return command?.constructor?.name ?? '';
}

function commandInput(command: unknown): Record<string, unknown> {
  return (command as { input?: Record<string, unknown> }).input ?? {};
}

function secretValueForId(secretId: string): string | undefined {
  if (secretId === directArn) {
    return arnSecretValue;
  }

  const logicalRef = mapping[secretId as keyof typeof mapping];

  return logicalRef ? secrets[logicalRef as keyof typeof secrets] : undefined;
}

function createClient(calls: AwsSecretsManagerCalls, options: AwsClientOptions = {}): AwsSecretsManagerClient {
  return {
    async send(command) {
      const input = commandInput(command);

      if (commandName(command) === 'BatchGetSecretValueCommand') {
        calls.batchGetSecretValue.push(input);
        const ids = Array.isArray(input.SecretIdList) ? input.SecretIdList : [];

        return {
          SecretValues: ids
            .map((secretId) => {
              const value = typeof secretId === 'string' ? secretValueForId(secretId) : undefined;

              return value && typeof secretId === 'string'
                ? {
                    Name: secretId === directArn ? 'direct/arn' : secretId,
                    ...(secretId === directArn ? { ARN: directArn } : {}),
                    SecretString: value,
                  }
                : undefined;
            })
            .filter(Boolean),
          ...(options.batchErrors ? { Errors: options.batchErrors } : {}),
        };
      }

      if (commandName(command) === 'GetSecretValueCommand') {
        calls.getSecretValue.push(input);
        const secretId = input.SecretId;
        const value = typeof secretId === 'string' ? secretValueForId(secretId) : undefined;

        if (!value) {
          const error = new Error('not found') as Error & { name: string };
          error.name = 'ResourceNotFoundException';
          throw error;
        }

        return {
          Name: secretId,
          SecretString: value,
        };
      }

      if (commandName(command) === 'ListSecretsCommand') {
        calls.listSecrets.push(input);

        if (options.paginatedList && !input.NextToken) {
          return {
            SecretList: [
              {
                Name: 'app/token',
              },
            ],
            NextToken: 'page-2',
          };
        }

        if (options.paginatedList && input.NextToken === 'page-2') {
          return {
            SecretList: [
              {
                Name: 'db/password',
              },
            ],
          };
        }

        return {
          SecretList: Object.keys(mapping).map((secretId) => ({
            Name: secretId,
          })),
        };
      }

      throw new Error(`Unexpected command: ${commandName(command)}`);
    },
  };
}

function createFactory(calls = createCalls(), options: AwsClientOptions = {}) {
  return {
    calls,
    factory: createAwsSecretsManagerVaultProvider({
      client: createClient(calls, options),
    }),
  };
}

defineSecretVaultProviderConformanceSuite(AWS_SECRETS_MANAGER_VAULT_PROVIDER, () => {
  const { factory } = createFactory();

  return {
    factory,
    definition: {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          region,
        },
      },
    },
    auth: {
      method: 'iam',
      config: {
        region,
      },
    },
    refs: secrets,
  };
});

defineSecretVaultRuntimeConformanceSuite(AWS_SECRETS_MANAGER_VAULT_PROVIDER, () => {
  const { calls, factory } = createFactory();

  return {
    factory,
    vaultId: 'aws-prod',
    definition: {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          region,
          endpoint: 'https://secretsmanager.us-east-1.amazonaws.com',
          clientSecret: 'should-not-project',
          nested: {
            privateKey: 'should-not-project',
            tenant: 'cnos',
          },
        },
      },
    },
    refs: secrets,
    expectedProjectedConfig: {
      region,
      endpoint: 'https://secretsmanager.us-east-1.amazonaws.com',
      nested: {
        tenant: 'cnos',
      },
    },
    afterReads() {
      expect(calls.batchGetSecretValue[0]).toEqual({
        SecretIdList: ['app/token', 'db/password'],
      });
      expect(calls.getSecretValue).toEqual([]);
    },
  };
});

describe('aws-secrets-manager request construction', () => {
  it('uses auth.config.versionId for pinned secret versions', async () => {
    const { calls, factory } = createFactory();
    const provider = factory.create('aws-prod', {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          region,
          versionId: 'version-123',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { region, versionId: 'version-123' } });
    await provider.get('db.password');

    expect(calls.getSecretValue).toEqual([
      {
        SecretId: 'db/password',
        VersionId: 'version-123',
      },
    ]);
  });

  it('uses auth.config.versionStage for staged secret versions', async () => {
    const { calls, factory } = createFactory();
    const provider = factory.create('aws-prod', {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          region,
          versionStage: 'AWSPREVIOUS',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { region, versionStage: 'AWSPREVIOUS' } });
    await provider.get('app.token');

    expect(calls.getSecretValue).toEqual([
      {
        SecretId: 'app/token',
        VersionStage: 'AWSPREVIOUS',
      },
    ]);
  });

  it('throws non-missing per-secret batch errors', async () => {
    const { factory } = createFactory(createCalls(), {
      batchErrors: [
        {
          ErrorCode: 'DecryptionFailure',
          Message: 'kms denied',
          SecretId: 'db/password',
        },
      ],
    });
    const provider = factory.create('aws-prod', {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          region,
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { region } });
    await expect(provider.batchGet(['db.password'])).rejects.toThrow('DecryptionFailure');
  });

  it('ignores missing per-secret batch errors', async () => {
    const { factory } = createFactory(createCalls(), {
      batchErrors: [
        {
          ErrorCode: 'ResourceNotFoundException',
          SecretId: 'missing',
        },
      ],
    });
    const provider = factory.create('aws-prod', {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          region,
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { region } });
    await expect(provider.batchGet(['db.password', 'missing'])).resolves.toEqual(
      new Map([['db.password', 'aws-password']]),
    );
  });

  it('keeps direct ARN refs keyed by the requested ARN during batch reads', async () => {
    const { factory } = createFactory();
    const provider = factory.create('aws-prod', {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      auth: {
        method: 'iam',
        config: {
          region,
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { region } });
    await expect(provider.batchGet([directArn])).resolves.toEqual(new Map([[directArn, arnSecretValue]]));
  });

  it('paginates list secrets until NextToken is exhausted', async () => {
    const { calls, factory } = createFactory(createCalls(), { paginatedList: true });
    const provider = factory.create('aws-prod', {
      provider: AWS_SECRETS_MANAGER_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          region,
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { region } });
    await expect(provider.list()).resolves.toEqual(['app.token', 'db.password']);
    expect(calls.listSecrets).toEqual([{}, { NextToken: 'page-2' }]);
  });
});
