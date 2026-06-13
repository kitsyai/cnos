import {
  defineSecretVaultProviderConformanceSuite,
  defineSecretVaultRuntimeConformanceSuite,
} from '@kitsy/cnos-vault-testkit';
import { describe, expect, it } from 'vitest';

import {
  FIREBASE_SECRETS_VAULT_PROVIDER,
  type FirebaseSecretsClient,
  createFirebaseSecretsVaultProvider,
} from '../src/index.js';

const projectId = 'cnos-firebase-project';
const secrets = {
  'app.token': 'firebase-token',
  'db.password': 'firebase-password',
};
const mapping = {
  APP_TOKEN: 'app.token',
  DB_PASSWORD: 'db.password',
};

interface FirebaseSecretsCalls {
  accessSecretVersion: string[];
  listSecrets: string[];
  getProjectId: number;
}

function createCalls(): FirebaseSecretsCalls {
  return {
    accessSecretVersion: [],
    listSecrets: [],
    getProjectId: 0,
  };
}

function createClient(calls: FirebaseSecretsCalls): FirebaseSecretsClient {
  return {
    async accessSecretVersion({ name }) {
      calls.accessSecretVersion.push(name);
      const secretId = name.split('/secrets/')[1]?.split('/')[0];
      const logicalRef = secretId ? mapping[secretId as keyof typeof mapping] : undefined;
      const value = logicalRef ? secrets[logicalRef as keyof typeof secrets] : undefined;

      if (!value) {
        const error = new Error('not found') as Error & { code: number };
        error.code = 5;
        throw error;
      }

      return [{ payload: { data: Buffer.from(value, 'utf8') } }];
    },
    async listSecrets({ parent }) {
      calls.listSecrets.push(parent);
      return [
        Object.keys(mapping).map((secretId) => ({
          name: `${parent}/secrets/${secretId}`,
        })),
      ];
    },
    async getProjectId() {
      calls.getProjectId += 1;
      return projectId;
    },
  };
}

function createFactory(calls = createCalls()) {
  return {
    calls,
    factory: createFirebaseSecretsVaultProvider({
      client: createClient(calls),
    }),
  };
}

defineSecretVaultProviderConformanceSuite(FIREBASE_SECRETS_VAULT_PROVIDER, () => {
  const { factory } = createFactory();

  return {
    factory,
    definition: {
      provider: FIREBASE_SECRETS_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          projectId,
        },
      },
    },
    auth: {
      method: 'iam',
      config: {
        projectId,
      },
    },
    refs: secrets,
  };
});

defineSecretVaultRuntimeConformanceSuite(FIREBASE_SECRETS_VAULT_PROVIDER, () => {
  const { calls, factory } = createFactory();

  return {
    factory,
    vaultId: 'firebase-prod',
    definition: {
      provider: FIREBASE_SECRETS_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          projectId,
          endpoint: 'secretmanager.googleapis.com',
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
      projectId,
      endpoint: 'secretmanager.googleapis.com',
      nested: {
        tenant: 'cnos',
      },
    },
    afterReads() {
      expect(calls.accessSecretVersion).toEqual([
        `projects/${projectId}/secrets/APP_TOKEN/versions/latest`,
        `projects/${projectId}/secrets/DB_PASSWORD/versions/latest`,
      ]);
    },
  };
});

describe('firebase-secrets ref path construction', () => {
  it('uses auth.config.version for pinned secret versions', async () => {
    const calls = createCalls();
    const provider = createFirebaseSecretsVaultProvider({ client: createClient(calls) }).create('firebase-prod', {
      provider: FIREBASE_SECRETS_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          projectId,
          version: '7',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { projectId, version: '7' } });
    await provider.get('db.password');

    expect(calls.accessSecretVersion).toEqual([
      `projects/${projectId}/secrets/DB_PASSWORD/versions/7`,
    ]);
  });

  it('uses auth.config.location for regional Secret Manager resources', async () => {
    const calls = createCalls();
    const provider = createFirebaseSecretsVaultProvider({ client: createClient(calls) }).create('firebase-regional', {
      provider: FIREBASE_SECRETS_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
        config: {
          projectId,
          location: 'us-central1',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { projectId, location: 'us-central1' } });
    await provider.get('app.token');
    await provider.list();

    expect(calls.accessSecretVersion).toEqual([
      `projects/${projectId}/locations/us-central1/secrets/APP_TOKEN/versions/latest`,
    ]);
    expect(calls.listSecrets).toEqual([`projects/${projectId}/locations/us-central1`]);
  });

  it('passes full Secret Manager version refs through unchanged', async () => {
    const calls = createCalls();
    const fullRef = `projects/${projectId}/secrets/DB_PASSWORD/versions/3`;
    const provider = createFirebaseSecretsVaultProvider({ client: createClient(calls) }).create('firebase-full-ref', {
      provider: FIREBASE_SECRETS_VAULT_PROVIDER,
      auth: {
        method: 'iam',
        config: {
          projectId: 'ignored-project',
          version: 'ignored-version',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { projectId: 'ignored-project' } });
    await provider.get(fullRef);

    expect(calls.accessSecretVersion).toEqual([fullRef]);
  });

  it('passes mapped full Secret Manager version refs through unchanged', async () => {
    const calls = createCalls();
    const fullRef = `projects/${projectId}/secrets/DB_PASSWORD/versions/5`;
    const provider = createFirebaseSecretsVaultProvider({ client: createClient(calls) }).create('firebase-full-ref-map', {
      provider: FIREBASE_SECRETS_VAULT_PROVIDER,
      mapping: {
        [fullRef]: 'db.password',
      },
      auth: {
        method: 'iam',
        config: {
          projectId: 'ignored-project',
          version: 'ignored-version',
        },
      },
    });

    await provider.authenticate({ method: 'iam', config: { projectId: 'ignored-project' } });
    await provider.get('db.password');

    expect(calls.accessSecretVersion).toEqual([fullRef]);
  });

  it('falls back to the SDK project ID when auth.config.projectId is omitted', async () => {
    const calls = createCalls();
    const provider = createFirebaseSecretsVaultProvider({ client: createClient(calls) }).create('firebase-adc', {
      provider: FIREBASE_SECRETS_VAULT_PROVIDER,
      mapping,
      auth: {
        method: 'iam',
      },
    });

    await provider.authenticate({ method: 'iam' });
    await provider.get('db.password');

    expect(calls.getProjectId).toBe(1);
    expect(calls.accessSecretVersion).toEqual([
      `projects/${projectId}/secrets/DB_PASSWORD/versions/latest`,
    ]);
  });
});
