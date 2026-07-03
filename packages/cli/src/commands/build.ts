import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import {
  buildBrowserProjectionArtifact,
  buildEnvProjectionArtifact,
  buildPublicProjectionArtifact,
  buildServerProjectionArtifact,
  type ProjectionFormat,
} from '../services/projections.js';
import { resolveFilesystemBasePath } from '../services/paths.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';

export async function runBuild(
  subcommand: string | undefined,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const infoArgs = [...(options.cliArgs ?? [])];
  const format = (consumeOption(infoArgs, '--format') ?? undefined) as ProjectionFormat | undefined;
  const isPublic = consumeFlag(infoArgs, '--public');
  const isDynamic = consumeFlag(infoArgs, '--dynamic');
  const framework = consumeOption(infoArgs, '--framework');
  consumeOption(infoArgs, '--prefix');
  const to = consumeOption(infoArgs, '--to');
  const provenanceTarget = consumeOption(infoArgs, '--with-provenance');

  if (!to) {
    throw new Error(`build ${subcommand ?? '(missing)'} requires --to <path>`);
  }

  let targetPath: string;
  let count = 0;

  switch (subcommand) {
    case 'env': {
      const result = await buildEnvProjectionArtifact(to, {
        ...options,
        cliArgs: [...(options.cliArgs ?? [])],
      }, format ?? 'dotenv');
      targetPath = result.targetPath;
      count = Object.keys(result.env).length;
      break;
    }
    case 'public': {
      const result = await buildPublicProjectionArtifact(to, {
        ...options,
        cliArgs: [...(options.cliArgs ?? [])],
      }, format ?? 'dotenv');
      targetPath = result.targetPath;
      count = Object.keys(result.env).length;
      break;
    }
    case 'server': {
      const result = await buildServerProjectionArtifact(to, options, format ?? 'json', { dynamic: isDynamic });
      targetPath = result.targetPath;
      count = 1;
      break;
    }
    case 'browser': {
      const result = await buildBrowserProjectionArtifact(to, options, format ?? 'json');
      targetPath = result.targetPath;
      count = 1;
      break;
    }
    default:
      throw new Error(`Unsupported build target: ${subcommand ?? '(missing)'}`);
  }

  if (options.json) {
    return printJson({
      to: targetPath,
      count,
      public: isPublic,
      ...(framework ? { framework } : {}),
      ...(provenanceTarget ? { provenance: provenanceTarget } : {}),
    });
  }

  return `built ${subcommand} artifact at ${displayPath(
    targetPath,
    resolveFilesystemBasePath(options.root, options.cwd ?? process.cwd()),
  )}`;
}
