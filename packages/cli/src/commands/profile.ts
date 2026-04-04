import path from 'node:path';

import { consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { saveCliContext } from '../services/context.js';
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
  const root = path.resolve(options.root ?? process.cwd());
  const cliArgs = [...(options.cliArgs ?? [])];

  if (action === 'create') {
    const profile = tail[0] ?? 'stage';
    const inherit = consumeOption(cliArgs, '--inherit');
    const result = await createProfileDefinition(root, profile, inherit);

    if (options.json) {
      return printJson(result);
    }

    return `created profile ${profile} at ${result.filePath}`;
  }

  if (action === 'use') {
    const profile = tail[0] ?? 'base';
    const result = await saveCliContext({
      root,
      profile,
    });

    if (options.json) {
      return printJson(result);
    }

    return `active profile set to ${profile} in ${result.filePath}`;
  }

  if (action === 'delete') {
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
