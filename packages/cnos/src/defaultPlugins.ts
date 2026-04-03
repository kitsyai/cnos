import type { CnosPlugin } from '@kitsy/cnos-core';
import { createBasicSchemaPlugin } from '@kitsy/cnos-plugin-basic-schema';
import { createCliArgsPlugin } from '@kitsy/cnos-plugin-cli-args';
import { createDotenvPlugin } from '@kitsy/cnos-plugin-dotenv';
import {
  createEnvExportPlugin,
  createPublicEnvExportPlugin,
} from '@kitsy/cnos-plugin-env-export';
import {
  createFilesystemSecretsPlugin,
  createFilesystemValuesPlugin,
} from '@kitsy/cnos-plugin-filesystem';
import { createProcessEnvPlugin } from '@kitsy/cnos-plugin-process-env';

export function defaultPlugins(): CnosPlugin[] {
  return [
    createFilesystemValuesPlugin(),
    createFilesystemSecretsPlugin(),
    createDotenvPlugin(),
    createProcessEnvPlugin(),
    createCliArgsPlugin(),
    createBasicSchemaPlugin(),
    createEnvExportPlugin(),
    createPublicEnvExportPlugin(),
  ];
}
