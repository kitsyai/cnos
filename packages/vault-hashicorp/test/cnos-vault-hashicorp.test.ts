import {
  defineSecretVaultProviderConformanceSuite,
  defineSecretVaultRuntimeConformanceSuite,
} from '@kitsy/cnos-vault-testkit';
import { describe, expect, it } from 'vitest';

import {
  HASHICORP_VAULT_PROVIDER,
  type HashicorpVaultHttpClient,
  type HashicorpVaultHttpRequest,
  createHashicorpVaultProvider,
} from '../src/index.js';

const address = 'https://vault.example.test';
const token = 'vault-token';
const secrets = {
  'app.token': 'vault-app-token',
  'db.password': 'vault-db-password',
};
const mapping = {
  'app/token#value': 'app.token',
  'db/password#password': 'db.password',
};

interface HashicorpVaultCalls {
  requests: HashicorpVaultHttpRequest[];
}

function createCalls(): HashicorpVaultCalls {
  return {
    requests: [],
  };
}

function secretForPath(path: string): Record<string, string> | undefined {
  if (path.endsWith('/app/token')) {
    return { value: secrets['app.token'] };
  }

  if (path.endsWith('/db/password')) {
    return { password: secrets['db.password'] };
  }

  return undefined;
}

function createClient(calls: HashicorpVaultCalls): HashicorpVaultHttpClient {
  return {
    async request(request) {
      calls.requests.push(request);

      if (request.path === 'sys/health') {
        return { status: 200, body: { initialized: true, sealed: false } };
      }

      if (request.query?.list === 'true') {
        return {
          status: 200,
          body: {
            data: {
              keys: ['app/', 'db/password'],
            },
          },
        };
      }

      const data = secretForPath(request.path);

      if (!data) {
        return { status: 404 };
      }

      if (request.path.includes('/data/')) {
        return {
          status: 200,
          body: {
            data: {
              data,
            },
          },
        };
      }

      return {
        status: 200,
        body: {
          data,
        },
      };
    },
  };
}

function createFactory(calls = createCalls()) {
  return {
    calls,
    factory: createHashicorpVaultProvider({
      client: createClient(calls),
    }),
  };
}

defineSecretVaultProviderConformanceSuite(HASHICORP_VAULT_PROVIDER, () => {
  const { factory } = createFactory();

  return {
    factory,
    definition: {
      provider: HASHICORP_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'token',
        token: {
          from: ['env:VAULT_TOKEN'],
        },
        config: {
          address,
          mount: 'secret',
          version: 2,
        },
      },
    },
    auth: {
      method: 'token',
      token,
      config: {
        address,
        mount: 'secret',
        version: 2,
      },
    },
    refs: secrets,
    processEnv: {
      VAULT_TOKEN: token,
    },
  };
});

defineSecretVaultRuntimeConformanceSuite(HASHICORP_VAULT_PROVIDER, () => {
  const { calls, factory } = createFactory();

  return {
    factory,
    vaultId: 'vault-prod',
    definition: {
      provider: HASHICORP_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'token',
        token: {
          from: ['env:VAULT_TOKEN'],
        },
        config: {
          address,
          mount: 'secret',
          namespace: 'admin/team-a',
          version: 2,
          clientSecret: 'should-not-project',
          nested: {
            privateKey: 'should-not-project',
            tenant: 'cnos',
          },
        },
      },
    },
    refs: secrets,
    processEnv: {
      VAULT_TOKEN: token,
    },
    expectedProjectedConfig: {
      address,
      mount: 'secret',
      namespace: 'admin/team-a',
      version: 2,
      nested: {
        tenant: 'cnos',
      },
    },
    afterReads() {
      expect(calls.requests.map((request) => request.path)).toEqual([
        'secret/data/app/token',
        'secret/data/db/password',
      ]);
      expect(calls.requests.every((request) => request.token === token)).toBe(true);
      expect(calls.requests.every((request) => request.namespace === 'admin/team-a')).toBe(true);
    },
  };
});

describe('hashicorp-vault request construction', () => {
  it('uses KV v1 paths when auth.config.version is 1', async () => {
    const { calls, factory } = createFactory();
    const provider = factory.create('vault-kv1', {
      provider: HASHICORP_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'token',
        token: {
          from: ['env:VAULT_TOKEN'],
        },
        config: {
          address,
          mount: 'kv',
          version: 1,
        },
      },
    });

    await provider.authenticate({ method: 'token', token, config: { address, mount: 'kv', version: 1 } });
    await provider.get('db.password');

    expect(calls.requests[0]).toMatchObject({
      address,
      path: 'kv/db/password',
      token,
    });
  });

  it('applies auth.config.path as a prefix', async () => {
    const { calls, factory } = createFactory();
    const provider = factory.create('vault-prefixed', {
      provider: HASHICORP_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'token',
        token: {
          from: ['env:VAULT_TOKEN'],
        },
        config: {
          address,
          mount: 'secret',
          path: 'apps/payments',
          version: 2,
        },
      },
    });

    await provider.authenticate({ method: 'token', token, config: { address } });
    await provider.get('app.token');

    expect(calls.requests[0]?.path).toBe('secret/data/apps/payments/app/token');
  });

  it('lists mapped refs without remote listing and remote refs without mapping', async () => {
    const mapped = createFactory();
    const mappedProvider = mapped.factory.create('vault-mapped', {
      provider: HASHICORP_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'token',
        token: {
          from: ['env:VAULT_TOKEN'],
        },
        config: {
          address,
        },
      },
    });

    await mappedProvider.authenticate({ method: 'token', token, config: { address } });
    await expect(mappedProvider.list()).resolves.toEqual(['app.token', 'db.password']);
    expect(mapped.calls.requests).toEqual([]);

    const remote = createFactory();
    const remoteProvider = remote.factory.create('vault-remote', {
      provider: HASHICORP_VAULT_PROVIDER,
      auth: {
        method: 'token',
        token: {
          from: ['env:VAULT_TOKEN'],
        },
        config: {
          address,
          mount: 'secret',
          version: 2,
        },
      },
    });

    await remoteProvider.authenticate({ method: 'token', token, config: { address } });
    await expect(remoteProvider.list()).resolves.toEqual(['db/password']);
    expect(remote.calls.requests[0]).toMatchObject({
      path: 'secret/metadata',
      query: { list: 'true' },
    });
  });

  it('rejects missing token authentication', async () => {
    const { factory } = createFactory();
    const provider = factory.create('vault-prod', {
      provider: HASHICORP_VAULT_PROVIDER,
      auth: {
        method: 'token',
        token: {
          from: ['env:VAULT_TOKEN'],
        },
        config: {
          address,
        },
      },
    });

    await expect(provider.authenticate({ method: 'token', config: { address } })).rejects.toThrow(
      'requires token authentication',
    );
  });
});
