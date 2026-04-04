import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  parseYaml,
  resolveConfigDocumentPath,
  resolveSecretStoreRoot,
  stringifyYaml,
  writeLocalSecret,
  type SecretReference,
} from '@kitsy/cnos/internal';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

function setNestedValue(target: Record<string, unknown>, pathSegments: string[], value: unknown): void {
  const [head, ...tail] = pathSegments;

  if (!head) {
    return;
  }

  if (tail.length === 0) {
    target[head] = value;
    return;
  }

  const nextTarget =
    target[head] && typeof target[head] === 'object' && !Array.isArray(target[head])
      ? (target[head] as Record<string, unknown>)
      : {};
  target[head] = nextTarget;
  setNestedValue(nextTarget, tail, value);
}

function parseScalarValue(rawValue: string): unknown {
  try {
    return parseYaml(rawValue);
  } catch {
    return rawValue;
  }
}

function unsetNestedValue(target: Record<string, unknown>, pathSegments: string[]): boolean {
  const [head, ...tail] = pathSegments;

  if (!head || !(head in target)) {
    return false;
  }

  if (tail.length === 0) {
    delete target[head];
    return true;
  }

  const nextValue = target[head];

  if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)) {
    return false;
  }

  const deleted = unsetNestedValue(nextValue as Record<string, unknown>, tail);

  if (deleted && Object.keys(nextValue as Record<string, unknown>).length === 0) {
    delete target[head];
  }

  return deleted;
}

function isSecretReference(value: unknown): value is SecretReference {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as SecretReference).provider === 'string' &&
      typeof (value as SecretReference).ref === 'string',
  );
}

async function readYamlDocument(filePath: string): Promise<Record<string, unknown>> {
  try {
    return parseYaml<Record<string, unknown>>(await readFile(filePath, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function getSelectedWorkspaceRoot(
  options: RuntimeServiceOptions & { target?: 'local' | 'global' },
  runtime: Awaited<ReturnType<typeof createRuntimeService>>,
): string {
  const target = options.target ?? 'local';
  const workspaceRoot = runtime.graph.workspace.workspaceRoots.find(
    (entry) => entry.scope === target && entry.workspaceId === runtime.graph.workspace.workspaceId,
  );

  if (!workspaceRoot) {
    throw new Error(`No ${target} workspace root is available for ${runtime.graph.workspace.workspaceId}`);
  }

  if (target === 'global' && !runtime.manifest.workspaces.global.allowWrite) {
    throw new Error('Global writes require workspaces.global.allowWrite: true');
  }

  return workspaceRoot.path;
}

export async function defineValue(
  namespace: 'value' | 'secret',
  configPath: string,
  rawValue: string,
  options: RuntimeServiceOptions & {
    target?: 'local' | 'global';
    mode?: 'local' | 'remote' | 'ref';
    provider?: string;
    passphrase?: string;
  } = {},
): Promise<{ filePath: string; value: unknown }> {
  if (namespace === 'secret') {
    const secret = await setSecret(configPath, rawValue, {
      ...options,
      mode: options.mode ?? 'local',
    });

    return {
      filePath: secret.filePath,
      value: {
        provider: secret.provider,
        ref: secret.ref,
      },
    };
  }

  const runtime = await createRuntimeService(options);
  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = resolveConfigDocumentPath(workspaceRoot, namespace, configPath, profile);
  const document = await readYamlDocument(filePath);

  const parsedValue = parseScalarValue(rawValue);
  setNestedValue(document, configPath.split('.'), parsedValue);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyYaml(document), 'utf8');

  return {
    filePath,
    value: parsedValue,
  };
}

export interface SecretWriteResult {
  filePath: string;
  ref: string;
  provider: string;
  storePath?: string;
}

export async function setSecret(
  configPath: string,
  rawValue: string,
  options: RuntimeServiceOptions & {
    target?: 'local' | 'global';
    mode?: 'local' | 'remote' | 'ref';
    provider?: string;
    passphrase?: string;
  } = {},
): Promise<SecretWriteResult> {
  const runtime = await createRuntimeService(options);
  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = resolveConfigDocumentPath(workspaceRoot, 'secret', configPath, profile);
  const document = await readYamlDocument(filePath);
  const mode = options.mode ?? 'local';
  let reference: SecretReference;
  let storePath: string | undefined;

  if (mode === 'local') {
    const passphrase =
      options.passphrase ??
      options.processEnv?.CNOS_SECRET_PASSPHRASE ??
      process.env.CNOS_SECRET_PASSPHRASE;

    if (!passphrase) {
      throw new Error('Local secret writes require --passphrase or CNOS_SECRET_PASSPHRASE');
    }

    const profileSegment = profile && profile !== 'base' ? profile : 'base';
    const ref = [
      runtime.manifest.project.name,
      runtime.graph.workspace.workspaceId,
      profileSegment,
      ...configPath.split('.'),
      randomUUID(),
    ]
      .map((segment) => segment.replace(/[^A-Za-z0-9._-]+/g, '-'))
      .join('/');

    storePath = await writeLocalSecret(resolveSecretStoreRoot(options.processEnv), ref, rawValue, passphrase);
    reference = {
      provider: 'local',
      ref,
    };
  } else {
    reference = {
      provider: options.provider ?? (mode === 'ref' ? 'ref' : 'remote'),
      ref: rawValue,
    };
  }

  setNestedValue(document, configPath.split('.'), reference);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyYaml(document), 'utf8');

  return {
    filePath,
    provider: reference.provider,
    ref: reference.ref,
    ...(storePath ? { storePath } : {}),
  };
}

export async function deleteSecret(
  configPath: string,
  options: RuntimeServiceOptions & { target?: 'local' | 'global' } = {},
): Promise<{ filePath: string; deleted: boolean; removedStore?: string }> {
  const runtime = await createRuntimeService(options);
  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = resolveConfigDocumentPath(workspaceRoot, 'secret', configPath, profile);
  const document = await readYamlDocument(filePath);
  const metadata = runtime.graph.entries.get(`secret.${configPath}`)?.winner.metadata;
  const deleted = unsetNestedValue(document, configPath.split('.'));

  if (!deleted) {
    return {
      filePath,
      deleted: false,
    };
  }

  await writeFile(filePath, stringifyYaml(document), 'utf8');

  let removedStore: string | undefined;
  const secretRef = metadata?.secretRef;

  if (isSecretReference(secretRef) && secretRef.provider === 'local') {
    const storePath = path
      .join(resolveSecretStoreRoot(options.processEnv), 'store', ...secretRef.ref.split('/'))
      .concat('.json');
    await rm(storePath, { force: true });
    removedStore = storePath;
  }

  return {
    filePath,
    deleted: true,
    ...(removedStore ? { removedStore } : {}),
  };
}

export async function deleteValue(
  namespace: 'value' | 'secret',
  configPath: string,
  options: RuntimeServiceOptions & { target?: 'local' | 'global' } = {},
): Promise<{ filePath: string; deleted: boolean; removedStore?: string }> {
  if (namespace === 'secret') {
    return deleteSecret(configPath, options);
  }

  const runtime = await createRuntimeService(options);
  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = resolveConfigDocumentPath(workspaceRoot, namespace, configPath, profile);
  const document = await readYamlDocument(filePath);
  const deleted = unsetNestedValue(document, configPath.split('.'));

  if (!deleted) {
    return {
      filePath,
      deleted: false,
    };
  }

  await writeFile(filePath, stringifyYaml(document), 'utf8');

  return {
    filePath,
    deleted: true,
  };
}
