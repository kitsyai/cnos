import path from 'node:path';

import { consumeFlag, consumeOption, consumePrivateFlag } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import { resolveFilesystemBasePath } from '../services/paths.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { saveCliContext } from '../services/context.js';
import { assertWritableConfigRoot } from '../services/rootAccess.js';
import {
  createProfileDefinition,
  deleteProfileDefinition,
  listProfiles,
  readProfileDefinition,
} from '../services/profiles.js';

function normalizeProfileAction(args: string[]): { action: 'create' | 'list' | 'use' | 'delete'; tail: string[] } {
  const [action = 'list', ...tail] = args;

  if (['create', 'list', 'use', 'delete', 'remove'].includes(action)) {
    return {
      action: action === 'remove' ? 'delete' : (action as 'create' | 'list' | 'use' | 'delete'),
      tail,
    };
  }

  return {
    action: 'list',
    tail: args,
  };
}

export async function runProfile(args: string[], options: RuntimeServiceOptions = {}): Promise<string> {
  const { action, tail } = normalizeProfileAction(args);
  const root = options.root ?? process.cwd();
  const displayRoot = resolveFilesystemBasePath(options.root, options.cwd ?? process.cwd());
  const cliArgs = [...(options.cliArgs ?? [])];

  if (action === 'create') {
    await assertWritableConfigRoot(`create profile ${tail[0] ?? 'stage'}`, options);
    const profile = tail[0] ?? 'stage';
    const inherit = consumeOption(cliArgs, '--inherit');
    const noInherit = consumeFlag(cliArgs, '--no-inherit');
    const privateProfile = consumePrivateFlag(cliArgs);

    if (inherit && noInherit) {
      throw new Error('profile create accepts either --inherit <name> or --no-inherit, not both');
    }

    const result = await createProfileDefinition(root, profile, inherit, {
      noInherit,
      privateProfile,
    });

    if (options.json) {
      return printJson(result);
    }

    if (noInherit) {
      return `created profile ${profile} at ${displayPath(result.filePath, displayRoot)} without inheriting base`;
    }

    return `created profile ${profile} at ${displayPath(result.filePath, displayRoot)}; inherits values from base by default`;
  }

  if (action === 'use') {
    const profile = tail[0] ?? 'base';
    const result = await saveCliContext({
      root: path.resolve(root),
      profile,
    });

    if (options.json) {
      return printJson(result);
    }

    return `active profile set to ${profile} in ${displayPath(result.filePath, displayRoot)}`;
  }

  if (action === 'delete') {
    await assertWritableConfigRoot(`delete profile ${tail[0] ?? 'base'}`, options);
    const profile = tail[0] ?? 'base';
    const result = await deleteProfileDefinition(root, profile);

    if (options.json) {
      return printJson(result);
    }

    return result.deleted ? `deleted profile ${profile}` : `profile ${profile} was not found`;
  }

  const profiles = await listProfiles(root);

  if (options.json) {
    const details = await Promise.all(
      profiles.map(async (profile) => ({
        profile,
        definition: await readProfileDefinition(root, profile),
      })),
    );
    return printJson(details);
  }

  return profiles.join('\n');
}
