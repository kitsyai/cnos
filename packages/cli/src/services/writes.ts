import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getNamespaceDefinition,
  normalizeDerivedValue,
  parseDerivation,
  createSecretVaultProvider,
  validateDerivedTargetNamespace,
  validateParsedDerivation,
  parseYaml,
  resolveConfigDocumentPath,
  resolveVaultAuth,
  stringifyYaml,
  type SecretReference,
} from '@kitsy/cnos/internal';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';
import { assertWritableConfigRoot } from './rootAccess.js';

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

function isProfilePrivate(profileDefinitionPath: string): Promise<boolean> {
  return readFile(profileDefinitionPath, 'utf8')
    .then((document) => {
      const parsed = parseYaml<Record<string, unknown>>(document);
      return Boolean(parsed?.private);
    })
    .catch(() => false);
}

async function resolveProfilePrivateFlag(
  runtime: Awaited<ReturnType<typeof createRuntimeService>>,
  profile: string,
): Promise<boolean> {
  if (profile === 'base') {
    return false;
  }

  const runtimeWorkspaceRoots = [...runtime.graph.workspace.workspaceRoots].reverse().map((entry) => entry.path);
  const profilePaths = collectProfileDefinitionPaths(runtimeWorkspaceRoots, profile);

  for (const profilePath of profilePaths) {
    const isPrivate = await isProfilePrivate(profilePath);

    if (isPrivate || (await resolveProfileExistence(profilePath))) {
      return isPrivate;
    }
  }

  return false;
}

function collectProfileDefinitionPaths(
  runtimeWorkspaceRoots: string[],
  profile: string,
): string[] {
  const candidates = new Set<string>();
  const profilePaths: string[] = [];
  const profileFilename = `${profile}.yml`;

  for (const workspaceRoot of runtimeWorkspaceRoots) {
    const workspaceProfilePath = path.join(workspaceRoot, 'profiles', profileFilename);
    if (!candidates.has(workspaceProfilePath)) {
      candidates.add(workspaceProfilePath);
      profilePaths.push(workspaceProfilePath);
    }

    if (path.basename(path.dirname(workspaceRoot)) === 'workspaces') {
      const manifestRoot = path.resolve(workspaceRoot, '..', '..');
      const manifestProfilePath = path.join(manifestRoot, 'profiles', profileFilename);
      if (!candidates.has(manifestProfilePath)) {
        candidates.add(manifestProfilePath);
        profilePaths.push(manifestProfilePath);
      }
    }
  }

  return profilePaths;
}

async function resolveProfileExistence(profilePath: string): Promise<boolean> {
  try {
    await readFile(profilePath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function resolveProfileDocumentPath(
  workspaceRoot: string,
  namespace: string,
  configPath: string,
  profile: string,
  runtime: Awaited<ReturnType<typeof createRuntimeService>>,
  writePrivate = false,
): Promise<string> {
  const isPrivate = (await resolveProfilePrivateFlag(runtime, profile)) || writePrivate;

  return resolveConfigDocumentPath(workspaceRoot, namespace, configPath, profile, isPrivate);
}

export async function defineValue(
  namespace: string,
  configPath: string,
  rawValue: string,
  options: RuntimeServiceOptions & {
    target?: 'local' | 'global';
    mode?: 'local' | 'remote' | 'ref';
    provider?: string;
    vault?: string;
    deriveExpression?: string;
    deriveExprMode?: boolean;
    parsedValue?: unknown;
  } = {},
): Promise<{ filePath: string; value: unknown }> {
  await assertWritableConfigRoot(`write ${namespace}.${configPath}`, options);

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
        ...(secret.vault ? { vault: secret.vault } : {}),
      },
    };
  }

  const runtime = await createRuntimeService(options);

  if (namespace !== 'value' && namespace !== 'secret' && !runtime.manifest.namespaces[namespace]) {
    throw new Error(`Cannot write ${namespace}.${configPath} because namespace "${namespace}" is not declared in .cnos/cnos.yml.`);
  }

  const namespaceDefinition = getNamespaceDefinition(runtime.manifest, namespace);

  if (namespaceDefinition.kind !== 'data') {
    throw new Error(`Cannot write ${namespace}.${configPath} because namespace "${namespace}" is not a data namespace.`);
  }

  if (namespaceDefinition.readonly) {
    throw new Error(`Cannot write ${namespace}.${configPath} because namespace "${namespace}" is readonly.`);
  }

  if (namespaceDefinition.sensitive) {
    throw new Error(`Cannot write ${namespace}.${configPath} with the generic data writer because namespace "${namespace}" is sensitive.`);
  }

  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = await resolveProfileDocumentPath(
    workspaceRoot,
    namespace,
    configPath,
    profile,
    runtime,
    options.writePrivate === true,
  );
  const document = await readYamlDocument(filePath);

  let parsedValue: unknown;

  if (options.deriveExpression !== undefined) {
    validateDerivedTargetNamespace(runtime.manifest, namespace);
    const derivedValue = normalizeDerivedValue(options.deriveExpression, options.deriveExprMode ?? false);
    validateParsedDerivation(runtime.manifest, parseDerivation(derivedValue));
    parsedValue = derivedValue;
  } else if (Object.hasOwn(options, 'parsedValue')) {
    parsedValue = options.parsedValue;
  } else {
    parsedValue = parseScalarValue(rawValue);
  }

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
  vault?: string;
}

export async function setSecret(
  configPath: string,
  rawValue: string,
  options: RuntimeServiceOptions & {
    target?: 'local' | 'global';
    mode?: 'local' | 'remote' | 'ref';
    provider?: string;
    vault?: string;
  } = {},
): Promise<SecretWriteResult> {
  const runtime = await createRuntimeService({
    ...options,
    secretResolution: 'lazy',
  });
  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = await resolveProfileDocumentPath(
    workspaceRoot,
    'secret',
    configPath,
    profile,
    runtime,
    options.writePrivate === true,
  );
  const document = await readYamlDocument(filePath);
  const vault = options.vault?.trim() || 'default';
  const vaultDefinition = runtime.manifest.vaults[vault];

  if (!vaultDefinition) {
    throw new Error(`Unknown vault "${vault}". Create it first with cnos vault create ${vault}.`);
  }

  const mode =
    options.mode ??
    (vaultDefinition.provider === 'local'
      ? 'local'
      : vaultDefinition.provider === 'github-secrets' || vaultDefinition.provider === 'environment'
        ? 'ref'
        : 'remote');
  let reference: { provider: string; ref: string; vault?: string };

  if (mode === 'local') {
    const auth = await resolveVaultAuth(vault, vaultDefinition, options.processEnv ?? process.env);
    const provider = createSecretVaultProvider(vault, vaultDefinition, options.processEnv ?? process.env);
    await provider.authenticate(auth);
    await provider.set(configPath, rawValue);
    reference = {
      provider: 'local',
      ref: configPath,
      vault,
    };
  } else {
    reference = {
      provider: options.provider?.trim() || vaultDefinition.provider,
      ref: rawValue || configPath.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase(),
      vault,
    };
  }

  setNestedValue(document, configPath.split('.'), reference);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyYaml(document), 'utf8');

  return {
    filePath,
    provider: reference.provider,
    ref: reference.ref,
    ...(reference.vault ? { vault: reference.vault } : {}),
  };
}

export async function deleteSecret(
  configPath: string,
  options: RuntimeServiceOptions & { target?: 'local' | 'global' } = {},
): Promise<{ filePath: string; deleted: boolean }> {
  await assertWritableConfigRoot(`delete secret.${configPath}`, options);
  const runtime = await createRuntimeService({
    ...options,
    secretResolution: 'lazy',
  });
  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = await resolveProfileDocumentPath(
    workspaceRoot,
    'secret',
    configPath,
    profile,
    runtime,
    options.writePrivate === true,
  );
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
  const secretRef = metadata?.secretRef;

  if (isSecretReference(secretRef) && secretRef.provider === 'local') {
    const definition = runtime.manifest.vaults[secretRef.vault ?? 'default'];

    if (definition) {
      const auth = await resolveVaultAuth(secretRef.vault ?? 'default', definition, options.processEnv ?? process.env);
      const provider = createSecretVaultProvider(secretRef.vault ?? 'default', definition, options.processEnv ?? process.env);
      await provider.authenticate(auth);
      await provider.delete(secretRef.ref);
    }
  }

  return {
    filePath,
    deleted: true,
  };
}

export async function deleteValue(
  namespace: string,
  configPath: string,
  options: RuntimeServiceOptions & { target?: 'local' | 'global' } = {},
): Promise<{ filePath: string; deleted: boolean }> {
  await assertWritableConfigRoot(`delete ${namespace}.${configPath}`, options);

  if (namespace === 'secret') {
    return deleteSecret(configPath, options);
  }

  const runtime = await createRuntimeService(options);

  if (namespace !== 'value' && namespace !== 'secret' && !runtime.manifest.namespaces[namespace]) {
    throw new Error(`Cannot delete ${namespace}.${configPath} because namespace "${namespace}" is not declared in .cnos/cnos.yml.`);
  }

  const namespaceDefinition = getNamespaceDefinition(runtime.manifest, namespace);

  if (namespaceDefinition.kind !== 'data') {
    throw new Error(`Cannot delete ${namespace}.${configPath} because namespace "${namespace}" is not a data namespace.`);
  }

  if (namespaceDefinition.readonly) {
    throw new Error(`Cannot delete ${namespace}.${configPath} because namespace "${namespace}" is readonly.`);
  }

  if (namespaceDefinition.sensitive) {
    throw new Error(`Cannot delete ${namespace}.${configPath} with the generic data writer because namespace "${namespace}" is sensitive.`);
  }

  const workspaceRoot = getSelectedWorkspaceRoot(options, runtime);
  const profile = options.profile ?? runtime.graph.profile;
  const filePath = await resolveProfileDocumentPath(
    workspaceRoot,
    namespace,
    configPath,
    profile,
    runtime,
    options.writePrivate === true,
  );
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
