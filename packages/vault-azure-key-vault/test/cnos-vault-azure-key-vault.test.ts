import {
  defineSecretVaultProviderConformanceSuite,
  defineSecretVaultRuntimeConformanceSuite,
} from '@kitsy/cnos-vault-testkit';
import { describe, expect, it } from 'vitest';

import {
  AZURE_KEY_VAULT_PROVIDER,
  type AzureKeyVaultClient,
  createAzureKeyVaultProvider,
} from '../src/index.js';

const vaultUrl = 'https://cnos-test.vault.azure.net';
const secrets = {
  'app.token': 'azure-token',
  'db.password': 'azure-password',
};
const mapping = {
  'app-token': 'app.token',
  'db-password': 'db.password',
};

interface AzureKeyVaultCalls {
  getSecret: Array<{ name: string; options?: { version?: string } }>;
  listPropertiesOfSecrets: number;
}

function createCalls(): AzureKeyVaultCalls {
  return {
    getSecret: [],
    listPropertiesOfSecrets: 0,
  };
}

function secretValueForName(name: string): string | undefined {
  const logicalRef = mapping[name as keyof typeof mapping];

  return logicalRef ? secrets[logicalRef as keyof typeof secrets] : undefined;
}

function createClient(calls: AzureKeyVaultCalls): AzureKeyVaultClient {
  return {
    async getSecret(name, options) {
      calls.getSecret.push({ name, ...(options ? { options } : {}) });
      const value = secretValueForName(name);

      if (!value) {
        const error = new Error('not found') as Error & { statusCode: number; code: string };
        error.statusCode = 404;
        error.code = 'SecretNotFound';
        throw error;
      }

      return { name, value };
    },
    async *listPropertiesOfSecrets() {
      calls.listPropertiesOfSecrets += 1;

      for (const name of Object.keys(mapping)) {
        yield { name };
      }
    },
  };
}

function createFactory(calls = createCalls()) {
  return {
    calls,
    factory: createAzureKeyVaultProvider({
      client: createClient(calls),
    }),
  };
}

defineSecretVaultProviderConformanceSuite(AZURE_KEY_VAULT_PROVIDER, () => {
  const { factory } = createFactory();

  return {
    factory,
    definition: {
      provider: AZURE_KEY_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
        },
      },
    },
    auth: {
      method: 'iam',
      config: {
        vaultUrl,
      },
    },
    refs: secrets,
  };
});

defineSecretVaultRuntimeConformanceSuite(AZURE_KEY_VAULT_PROVIDER, () => {
  const { calls, factory } = createFactory();

  return {
    factory,
    vaultId: 'azure-prod',
    definition: {
      provider: AZURE_KEY_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
          tenantId: 'tenant-id',
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
      vaultUrl,
      tenantId: 'tenant-id',
      nested: {
        tenant: 'cnos',
      },
    },
    afterReads() {
      expect(calls.getSecret).toEqual([
        { name: 'app-token' },
        { name: 'db-password' },
      ]);
    },
  };
});

describe('azure-key-vault request construction', () => {
  it('uses auth.config.version for pinned secret versions', async () => {
    const { calls, factory } = createFactory();
    const provider = factory.create('azure-prod', {
      provider: AZURE_KEY_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
          version: 'version-1',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { vaultUrl, version: 'version-1' } });
    await provider.get('db.password');

    expect(calls.getSecret).toEqual([
      {
        name: 'db-password',
        options: {
          version: 'version-1',
        },
      },
    ]);
  });

  it('uses full Azure secret URLs when provided as refs', async () => {
    const { calls, factory } = createFactory();
    const fullRef = `${vaultUrl}/secrets/db-password/version-2`;
    const provider = factory.create('azure-prod', {
      provider: AZURE_KEY_VAULT_PROVIDER,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
          version: 'ignored-version',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { vaultUrl } });
    await provider.get(fullRef);

    expect(calls.getSecret).toEqual([
      {
        name: 'db-password',
        options: {
          version: 'version-2',
        },
      },
    ]);
  });

  it('rejects full Azure secret URLs from a different vault origin', async () => {
    const { factory } = createFactory();
    const provider = factory.create('azure-prod', {
      provider: AZURE_KEY_VAULT_PROVIDER,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { vaultUrl } });
    await expect(
      provider.get('https://other-vault.vault.azure.net/secrets/db-password/version-2'),
    ).rejects.toThrow('does not match configured vaultUrl');
  });

  it('lists mapped refs without remote listing and remote refs without mapping', async () => {
    const mapped = createFactory();
    const mappedProvider = mapped.factory.create('azure-mapped', {
      provider: AZURE_KEY_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
        },
      },
    });

    await mappedProvider.authenticate({ method: 'iam', config: { vaultUrl } });
    await expect(mappedProvider.list()).resolves.toEqual(['app.token', 'db.password']);
    expect(mapped.calls.listPropertiesOfSecrets).toBe(0);

    const remote = createFactory();
    const remoteProvider = remote.factory.create('azure-remote', {
      provider: AZURE_KEY_VAULT_PROVIDER,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
        },
      },
    });

    await remoteProvider.authenticate({ method: 'iam', config: { vaultUrl } });
    await expect(remoteProvider.list()).resolves.toEqual(['app-token', 'db-password']);
    expect(remote.calls.listPropertiesOfSecrets).toBe(1);
  });

  it('rejects token auth because Azure credentials are SDK-managed', async () => {
    const { factory } = createFactory();
    const provider = factory.create('azure-prod', {
      provider: AZURE_KEY_VAULT_PROVIDER,
      auth: {
        method: 'iam',
        config: {
          vaultUrl,
        },
      },
    });

    await expect(provider.authenticate({ method: 'token', token: 'raw-token', config: { vaultUrl } })).rejects.toThrow(
      'requires iam authentication',
    );
  });
});
