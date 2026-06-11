import {
  defineSecretVaultProviderConformanceSuite,
  defineSecretVaultRuntimeConformanceSuite,
} from '@kitsy/cnos-vault-testkit';
import { expect } from 'vitest';

import {
  FAKE_REMOTE_VAULT_PROVIDER,
  createFakeRemoteVaultCalls,
  createFakeRemoteVaultProvider,
} from '../src/index.js';

const secrets = {
  'app.token': 'fake-token',
  'db.password': 'fake-password',
};

defineSecretVaultProviderConformanceSuite(FAKE_REMOTE_VAULT_PROVIDER, () => ({
  factory: createFakeRemoteVaultProvider({ secrets }),
  definition: {
    provider: FAKE_REMOTE_VAULT_PROVIDER,
    auth: {
      method: 'token',
      token: {
        from: ['env:FAKE_REMOTE_TOKEN'],
      },
      config: {
        endpoint: 'https://fake-vault.local',
      },
    },
  },
  auth: {
    method: 'token',
    token: 'test-token',
    config: {
      endpoint: 'https://fake-vault.local',
    },
  },
  refs: secrets,
  processEnv: {
    FAKE_REMOTE_TOKEN: 'test-token',
  },
}));

defineSecretVaultRuntimeConformanceSuite(FAKE_REMOTE_VAULT_PROVIDER, () => {
  const calls = createFakeRemoteVaultCalls();

  return {
    factory: createFakeRemoteVaultProvider({ secrets, calls }),
    vaultId: 'fake-prod',
    definition: {
      provider: FAKE_REMOTE_VAULT_PROVIDER,
      auth: {
        method: 'token',
        token: {
          from: ['env:FAKE_REMOTE_TOKEN'],
        },
      },
    },
    refs: secrets,
    processEnv: {
      FAKE_REMOTE_TOKEN: 'test-token',
    },
    afterReads() {
      expect(calls.authenticate).toHaveLength(1);
      expect(calls.batchGet).toEqual([Object.keys(secrets)]);
      expect(calls.get).toEqual([]);
    },
  };
});
