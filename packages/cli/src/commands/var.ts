import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';

import { consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import {
  createLocalVarControl,
  createRemoteVarControl,
  parseDocumentArg,
  startStandaloneVarServer,
  type VarControl,
  type VarMutationMeta,
} from '../services/varControl.js';

const ACTIONS = new Set([
  'create',
  'validate',
  'activate',
  'deactivate',
  'rollback',
  'status',
  'history',
  'replay',
  'serve',
]);

async function loadDocuments(
  options: RuntimeServiceOptions,
): Promise<Record<string, DocumentSchemaDefinition>> {
  try {
    const runtime = await createRuntimeService(options);
    return runtime.toServerProjection().documents ?? {};
  } catch {
    return {};
  }
}

function requireGeneration(cliArgs: string[]): number {
  const raw = consumeOption(cliArgs, '--expect-generation');

  if (raw === undefined) {
    throw new Error('--expect-generation <N> is required for this command (optimistic concurrency guard).');
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--expect-generation must be a non-negative integer, got "${raw}".`);
  }

  return value;
}

function readMeta(cliArgs: string[]): VarMutationMeta {
  const actor = consumeOption(cliArgs, '--actor');
  const reason = consumeOption(cliArgs, '--reason');
  const idempotencyKey = consumeOption(cliArgs, '--idempotency-key');

  return {
    ...(actor !== undefined ? { actor } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

async function resolveControl(
  cliArgs: string[],
  options: RuntimeServiceOptions,
  needsDocuments: boolean,
): Promise<VarControl> {
  const store = consumeOption(cliArgs, '--store');
  const server = consumeOption(cliArgs, '--server');
  const bearer = consumeOption(cliArgs, '--bearer-token');

  if (server) {
    return createRemoteVarControl({ server, ...(bearer ? { bearer } : {}) });
  }

  if (store) {
    const documents = needsDocuments ? await loadDocuments(options) : undefined;
    return createLocalVarControl({ storePath: store, ...(documents ? { documents } : {}) });
  }

  throw new Error('Specify a target: --store <path> for local mode or --server <url> for a running var server.');
}

async function runServe(cliArgs: string[], options: RuntimeServiceOptions): Promise<string> {
  const storePath = consumeOption(cliArgs, '--store');
  const host = consumeOption(cliArgs, '--host');
  const portRaw = consumeOption(cliArgs, '--port');
  const bearerToken = consumeOption(cliArgs, '--bearer-token');
  const documents = await loadDocuments(options);

  const running = await startStandaloneVarServer({
    ...(storePath ? { storePath } : {}),
    ...(Object.keys(documents).length > 0 ? { documents } : {}),
    ...(host ? { host } : {}),
    ...(portRaw ? { port: Number(portRaw) } : {}),
    ...(bearerToken ? { bearerToken } : {}),
  });

  process.stderr.write(
    `cnos var serve listening on ${running.url} (${storePath ? `fileStore ${storePath}` : 'memoryStore (ephemeral)'})\n`,
  );

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.close().then(resolve);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return '';
}

export async function runVar(args: string[] = [], options: RuntimeServiceOptions = {}): Promise<string> {
  const [action = 'status', ...rest] = args;
  const cliArgs = [...(options.cliArgs ?? [])];

  if (!ACTIONS.has(action)) {
    throw new Error(`Unknown var subcommand "${action}". Expected one of: ${[...ACTIONS].join(', ')}.`);
  }

  if (action === 'serve') {
    return runServe(cliArgs, options);
  }

  const scope = rest[0];
  const emit = (value: unknown): string => (options.json ? printJson(value) : formatText(action, value));

  if (action === 'create') {
    if (!scope) {
      throw new Error('cnos var create <scope> requires a scope.');
    }

    const documentArg = consumeOption(cliArgs, '--document');

    if (documentArg === undefined) {
      throw new Error('cnos var create requires --document <json|@file>.');
    }

    const schemaId = consumeOption(cliArgs, '--schema');
    const meta = readMeta(cliArgs);
    const control = await resolveControl(cliArgs, options, true);
    const document = await parseDocumentArg(documentArg);
    return emit(await control.createRevision(scope, document, schemaId, meta));
  }

  if (action === 'validate') {
    const documentArg = consumeOption(cliArgs, '--document');

    if (documentArg === undefined) {
      throw new Error('cnos var validate requires --document <json|@file>.');
    }

    const schemaId = consumeOption(cliArgs, '--schema');
    const control = await resolveControl(cliArgs, options, true);
    const document = await parseDocumentArg(documentArg);
    return emit(await control.validateRevision(scope, document, schemaId));
  }

  if (action === 'activate') {
    if (!scope) {
      throw new Error('cnos var activate <scope> requires a scope.');
    }

    const revision = consumeOption(cliArgs, '--revision');

    if (revision === undefined) {
      throw new Error('cnos var activate requires --revision <sha256:...>.');
    }

    const expectedGeneration = requireGeneration(cliArgs);
    const meta = readMeta(cliArgs);
    const control = await resolveControl(cliArgs, options, false);
    return emit(await control.activate(scope, revision, expectedGeneration, meta));
  }

  if (action === 'deactivate') {
    if (!scope) {
      throw new Error('cnos var deactivate <scope> requires a scope.');
    }

    const expectedGeneration = requireGeneration(cliArgs);
    const meta = readMeta(cliArgs);
    const control = await resolveControl(cliArgs, options, false);
    return emit(await control.deactivate(scope, expectedGeneration, meta));
  }

  if (action === 'rollback') {
    if (!scope) {
      throw new Error('cnos var rollback <scope> requires a scope.');
    }

    const toRevision = consumeOption(cliArgs, '--to-revision');
    const toGenerationRaw = consumeOption(cliArgs, '--to-generation');
    const expectedGeneration = requireGeneration(cliArgs);
    const meta = readMeta(cliArgs);
    const control = await resolveControl(cliArgs, options, false);
    return emit(
      await control.rollback(
        scope,
        expectedGeneration,
        {
          ...(toRevision ? { toRevision } : {}),
          ...(toGenerationRaw !== undefined ? { toGeneration: Number(toGenerationRaw) } : {}),
        },
        meta,
      ),
    );
  }

  if (action === 'replay') {
    if (!scope) {
      throw new Error('cnos var replay <scope> requires a scope.');
    }

    const toGenerationRaw = consumeOption(cliArgs, '--to-generation');

    if (toGenerationRaw === undefined) {
      throw new Error('cnos var replay requires --to-generation <N>.');
    }

    const control = await resolveControl(cliArgs, options, false);
    return emit(await control.replay(scope, Number(toGenerationRaw)));
  }

  // status | history
  if (!scope) {
    throw new Error(`cnos var ${action} <scope> requires a scope.`);
  }

  const control = await resolveControl(cliArgs, options, false);
  return emit(action === 'history' ? await control.history(scope) : await control.status(scope));
}

function formatText(action: string, value: unknown): string {
  return `${action}: ${printJson(value)}`;
}
