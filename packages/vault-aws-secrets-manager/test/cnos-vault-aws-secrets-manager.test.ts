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
const mapping = {
  'app/token': 'app.token',
  'db/password': 'db.password',
};

interface AwsSecretsManagerCalls {
  batchGetSecretValue: Array<Record<string, unknown>>;
  getSecretValue: Array<Record<string, unknown>>;
  listSecrets: Array<Record<string, unknown>>;
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

function createClient(calls: AwsSecretsManagerCalls): AwsSecretsManagerClient {
  return {
    async send(command) {
      const input = commandInput(command);

      if (commandName(command) === 'BatchGetSecretValueCommand') {
        calls.batchGetSecretValue.push(input);
        const ids = Array.isArray(input.SecretIdList) ? input.SecretIdList : [];

        return {
          SecretValues: ids
            .map((secretId) => {
              const logicalRef = typeof secretId === 'string' ? mapping[secretId as keyof typeof mapping] : undefined;
              const value = logicalRef ? secrets[logicalRef as keyof typeof secrets] : undefined;

              return value && typeof secretId === 'string'
                ? {
                    Name: secretId,
                    SecretString: value,
                  }
                : undefined;
            })
            .filter(Boolean),
        };
      }

      if (commandName(command) === 'GetSecretValueCommand') {
        calls.getSecretValue.push(input);
        const secretId = input.SecretId;
        const logicalRef = typeof secretId === 'string' ? mapping[secretId as keyof typeof mapping] : undefined;
        const value = logicalRef ? secrets[logicalRef as keyof typeof secrets] : undefined;

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

function createFactory(calls = createCalls()) {
  return {
    calls,
    factory: createAwsSecretsManagerVaultProvider({
      client: createClient(calls),
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
});
