import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  detectLegacyVaultFormat,
  isSecretReference,
  loadManifest,
  parseYaml,
  readKeychain,
  resolveSecretStoreRoot,
  stringifyYaml,
  type ValidationIssue,
} from '@kitsy/cnos/internal';

import { createValidationSummary } from './validation.js';
import { resolveFilesystemBasePath } from './paths.js';
import type { RuntimeServiceOptions } from './runtime.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  details: string;
}

export interface SecretEnvMappingRepairResult {
  manifestPath: string;
  removed: Array<{
    envVar: string;
    logicalKey: string;
  }>;
}

async function checkGitignore(root: string): Promise<DoctorCheck> {
  const gitignorePath = path.join(root, '.gitignore');
  const expected = [
    '.cnos/.private',
    '.cnos/env/.env',
    '.cnos/env/.env.*',
    '!.cnos/env/.env.example',
    '!.cnos/env/.env.*.example',
    '.cnos/workspaces/*/.private',
    '.cnos/workspaces/*/env/.env',
    '.cnos/workspaces/*/env/.env.*',
    '!.cnos/workspaces/*/env/.env.example',
    '!.cnos/workspaces/*/env/.env.*.example',
  ];

  try {
    const content = await readFile(gitignorePath, 'utf8');
    const missing = expected.filter((entry) => !content.includes(entry));

    return {
      name: 'gitignore',
      ok: missing.length === 0,
      details:
        missing.length === 0
          ? 'workspace secrets and live env files are ignored while example env files stay trackable'
          : `missing: ${missing.join(', ')}`,
    };
  } catch {
    return {
      name: 'gitignore',
      ok: false,
      details: 'missing .gitignore',
    };
  }
}

function issueSummary(issues: ValidationIssue[]): string {
  return issues.length === 0 ? 'no issues' : issues.map((issue) => issue.message).join('; ');
}

async function collectYamlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const target = path.join(root, entry.name);

      if (entry.isDirectory()) {
        results.push(...(await collectYamlFiles(target)));
        continue;
      }

      if (entry.isFile() && ['.yml', '.yaml'].includes(path.extname(entry.name).toLowerCase())) {
        results.push(target);
      }
    }

    return results;
  } catch {
    return [];
  }
}

function hasPlaintextSecret(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }

  if (isSecretReference(value)) {
    return false;
  }

  return Object.values(value).some((entry) => hasPlaintextSecret(entry));
}

async function checkSecretSecurity(
  options: RuntimeServiceOptions,
  runtime: Awaited<ReturnType<typeof createValidationSummary>>['runtime'],
): Promise<DoctorCheck> {
  const storeRoot = resolveSecretStoreRoot(options.processEnv);
  const legacyPaths = await Promise.all(
    Object.entries(runtime.manifest.vaults)
      .filter(([, definition]) => definition.provider === 'local')
      .map(async ([vault]) => ({ vault, path: await detectLegacyVaultFormat(storeRoot, vault) })),
  );
  const legacyDetected = legacyPaths.filter((entry) => Boolean(entry.path));
  const secretFiles = await Promise.all(
    runtime.graph.workspace.workspaceRoots
      .filter((root) => root.scope === 'local')
      .map((root) => collectYamlFiles(path.join(root.path, 'secrets'))),
  );
  const plaintextFiles: string[] = [];

  for (const file of secretFiles.flat()) {
    try {
      const parsed = parseYaml<unknown>(await readFile(file, 'utf8'));

      if (hasPlaintextSecret(parsed)) {
        plaintextFiles.push(file);
      }
    } catch {
      plaintextFiles.push(file);
    }
  }

  const keychainWarnings = await Promise.all(
    Object.entries(runtime.manifest.vaults)
      .filter(([, definition]) => definition.provider === 'local')
      .flatMap(([vault, definition]) =>
        (definition.auth?.passphrase?.from ?? [])
          .filter((source) => source.startsWith('keychain:'))
          .map(async (source) => ({ vault, source, value: await readKeychain(source.slice('keychain:'.length)) })),
      ),
  );

  const warnings = [
    ...legacyDetected.map((entry) => `legacy vault ${entry.vault}: ${entry.path}`),
    ...plaintextFiles.map((file) => `plaintext secret file: ${file}`),
    ...Object.entries(runtime.manifest.envMapping.explicit)
      .filter(([, logicalKey]) => logicalKey.startsWith('secret.'))
      .map(([envVar, logicalKey]) => `secret env mapping: ${envVar} -> ${logicalKey}`),
    ...keychainWarnings
      .filter((entry) => !entry.value)
      .map((entry) => `no keychain entry for vault ${entry.vault} (${entry.source})`),
  ];

  return {
    name: 'security',
    ok: warnings.length === 0,
    details: warnings.length === 0 ? 'no legacy vaults, plaintext secret files, or missing keychain entries' : warnings.join('; '),
  };
}

export async function repairSecretEnvMappings(
  options: RuntimeServiceOptions = {},
): Promise<SecretEnvMappingRepairResult> {
  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  const explicit = loadedManifest.rawManifest.envMapping?.explicit ?? {};
  const removed = Object.entries(explicit)
    .filter(([, logicalKey]) => logicalKey.startsWith('secret.'))
    .map(([envVar, logicalKey]) => ({ envVar, logicalKey }));

  if (removed.length === 0) {
    return {
      manifestPath: loadedManifest.manifestPath,
      removed,
    };
  }

  const nextExplicit = Object.fromEntries(
    Object.entries(explicit).filter(([, logicalKey]) => !logicalKey.startsWith('secret.')),
  );
  const nextRawManifest = {
    ...loadedManifest.rawManifest,
    envMapping: {
      ...(loadedManifest.rawManifest.envMapping ?? {}),
      explicit: nextExplicit,
    },
  };

  await writeFile(loadedManifest.manifestPath, stringifyYaml(nextRawManifest), 'utf8');

  return {
    manifestPath: loadedManifest.manifestPath,
    removed,
  };
}

export async function evaluateDoctor(options: RuntimeServiceOptions = {}): Promise<DoctorCheck[]> {
  const root = resolveFilesystemBasePath(options.root, options.cwd ?? process.cwd());
  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  const { runtime, summary } = await createValidationSummary(options);
  const localRoot = runtime.graph.workspace.workspaceRoots.find((entry) => entry.scope === 'local');
  const globalRoot = runtime.graph.workspace.workspaceRoots.find((entry) => entry.scope === 'global');
  const declaredCustomNamespaces = Object.entries(runtime.manifest.namespaces)
    .filter(([namespace]) => !['value', 'secret', 'meta', 'process', 'public', 'env'].includes(namespace))
    .map(([namespace, definition]) => `${namespace}(${definition.kind}${definition.shareable ? ',shareable' : ''}${definition.readonly ? ',readonly' : ''})`)
    .sort((left, right) => left.localeCompare(right));

  return [
    {
      name: 'manifest',
      ok: true,
      details: `project=${runtime.manifest.project.name}`,
    },
    {
      name: 'workspace',
      ok: true,
      details: `${runtime.graph.workspace.workspaceId} via ${runtime.graph.workspace.workspaceSource}`,
    },
    {
      name: 'root',
      ok: true,
      details: loadedManifest.rootResolution.remote
        ? `${loadedManifest.rootResolution.rootUri} -> ${loadedManifest.manifestRoot}${loadedManifest.rootResolution.immutable ? ' | immutable' : ' | mutable ref'}${loadedManifest.rootResolution.resolvedCommit ? ` | commit ${loadedManifest.rootResolution.resolvedCommit}` : ''}`
        : loadedManifest.manifestRoot,
    },
    {
      name: 'namespaces',
      ok: true,
      details:
        declaredCustomNamespaces.length === 0
          ? 'built-ins: value, secret, meta, process, public, env'
          : `built-ins: value, secret, meta, process, public, env | custom: ${declaredCustomNamespaces.join(', ')}`,
    },
    {
      name: 'source-roots',
      ok: Boolean(localRoot),
      details: [localRoot?.path, globalRoot?.path].filter(Boolean).join(' | '),
    },
    {
      name: 'validation',
      ok: summary.valid,
      details: issueSummary(summary.issues),
    },
    {
      name: 'global-policy',
      ok: !runtime.manifest.workspaces.global.enabled || Boolean(runtime.graph.workspace.globalRoot),
      details: runtime.manifest.workspaces.global.enabled
        ? runtime.graph.workspace.globalRoot
          ? `enabled at ${runtime.graph.workspace.globalRoot}`
          : 'enabled but no global root resolved'
        : 'disabled',
    },
    await checkSecretSecurity(options, runtime),
    await checkGitignore(root),
  ];
}
