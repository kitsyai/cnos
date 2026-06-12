import {
  defineSecretVaultProviderConformanceSuite,
  defineSecretVaultRuntimeConformanceSuite,
} from '@kitsy/cnos-vault-testkit';

import {
  GCP_SECRET_MANAGER_VAULT_PROVIDER,
  type GcpSecretManagerClient,
  createGcpSecretManagerVaultProvider,
} from '../src/index.js';
import { expect } from 'vitest';

const projectId = 'cnos-test-project';
const secrets = {
  'app.token': 'gcp-token',
  'db.password': 'gcp-password',
};
const mapping = {
  'app-token': 'app.token',
  'db-password': 'db.password',
};

interface GcpSecretManagerCalls {
  accessSecretVersion: string[];
  listSecrets: string[];
  getProjectId: number;
}

function createCalls(): GcpSecretManagerCalls {
  return {
    accessSecretVersion: [],
    listSecrets: [],
    getProjectId: 0,
  };
}

function createClient(calls: GcpSecretManagerCalls): GcpSecretManagerClient {
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
    factory: createGcpSecretManagerVaultProvider({
      client: createClient(calls),
    }),
  };
}

defineSecretVaultProviderConformanceSuite(GCP_SECRET_MANAGER_VAULT_PROVIDER, () => {
  const { factory } = createFactory();

  return {
    factory,
    definition: {
      provider: GCP_SECRET_MANAGER_VAULT_PROVIDER,
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

defineSecretVaultRuntimeConformanceSuite(GCP_SECRET_MANAGER_VAULT_PROVIDER, () => {
  const { calls, factory } = createFactory();

  return {
    factory,
    vaultId: 'gcp-prod',
    definition: {
      provider: GCP_SECRET_MANAGER_VAULT_PROVIDER,
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
        `projects/${projectId}/secrets/app-token/versions/latest`,
        `projects/${projectId}/secrets/db-password/versions/latest`,
      ]);
    },
  };
});
