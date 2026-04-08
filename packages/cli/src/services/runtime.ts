import { createCnos } from '@kitsy/cnos';

import { getVaultPassphraseEnvVar } from '@kitsy/cnos/internal';

import { consumeOption } from '../cli/commandOptions.js';

export interface RuntimeServiceOptions {
  root?: string;
  workspace?: string;
  profile?: string;
  globalRoot?: string;
  json?: boolean;
  verbose?: boolean;
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}

function deriveRuntimeProcessEnv(options: RuntimeServiceOptions): Record<string, string | undefined> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const vault = consumeOption(cliArgs, '--vault') ?? 'default';
  const passphrase = consumeOption(cliArgs, '--passphrase');
  const baseEnv = {
    ...(options.processEnv ?? process.env),
  };

  if (!passphrase) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    [getVaultPassphraseEnvVar(vault)]: passphrase,
  };
}

export async function createRuntimeService(options: RuntimeServiceOptions = {}) {
  const createOptions = {
    ...(options.root
      ? {
          root: options.root,
        }
      : {}),
    ...(options.workspace
      ? {
          workspace: options.workspace,
        }
      : {}),
    ...(options.profile
      ? {
          profile: options.profile,
        }
      : {}),
    ...(options.globalRoot
      ? {
          globalRoot: options.globalRoot,
        }
      : {}),
    ...(options.cliArgs && options.cliArgs.length > 0
      ? {
          cliArgs: options.cliArgs,
        }
      : {}),
    processEnv: deriveRuntimeProcessEnv(options),
  };

  return createCnos({
    ...createOptions,
  });
}
