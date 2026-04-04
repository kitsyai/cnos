import { createCnos } from '@kitsy/cnos';

export interface RuntimeServiceOptions {
  root?: string;
  workspace?: string;
  profile?: string;
  globalRoot?: string;
  json?: boolean;
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
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
    ...(options.processEnv
      ? {
          processEnv: options.processEnv,
        }
      : {
          processEnv: process.env,
        }),
  };

  return createCnos({
    ...createOptions,
  });
}
