import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createDefaultRuntimeProviders,
  createDerivedRuntimeSupport,
  assertSecretRefVaultProviderCompatible,
  inspectValue,
  isDerivedValue,
  parseDerivation,
  registerRuntimeProvider,
  type CnosRuntime,
  type LogicalKey,
  type NormalizedManifest,
  type ResolvedGraph,
  type ResolvedEntry,
  type ServerProjection,
  type CnosCreateOptions,
  type RuntimeProvider,
  type SecretReference,
  type SecretVaultProviderFactory,
  type VaultDefinition,
  type ResolvedVarSnapshot,
  type VarSnapshotBatch,
  type VarSourceProviderModule,
  type VarStatusReport,
  type VarWatchCallback,
  readValue,
  requireValue,
  toEnv,
  toLogicalKey,
  toNamespaceObject,
  toPublicEnv,
} from '@kitsy/cnos-core';
import { createSecretVaultProvider } from '@kitsy/cnos-core';
import { resolveVaultAuth } from '@kitsy/cnos-core';

import { createCnos } from '../createCnos.js';
import { defaultVarSourceProviders } from '../defaultVarSourceProviders.js';
import { createSingletonVarSupport } from './varSupport.js';
import {
  CNOS_GRAPH_ENV_VAR,
  CNOS_PROJECTION_ENV_VAR,
  deserializeServerProjection,
  CNOS_REQUIRE_SERVER_PROJECTION_ENV_VAR,
  CNOS_SERVER_PROJECTION_PATH_ENV_VAR,
  graphRequiresSecretHydration,
  readRuntimeGraphFromEnv,
  readServerProjectionFromEnv,
} from './bootstrap.js';
import {
  getBootstrappedSecretHydrationRequired,
  getSingletonReady,
  getSingletonRuntime,
  setBootstrappedSecretHydrationRequired,
  setSingletonReady,
  setSingletonRuntime,
} from './state.js';

export interface CnosSingleton {
  <T = unknown>(key: LogicalKey): T | undefined;
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;
  value<T = unknown>(path: string): T | undefined;
  secret<T = unknown>(path: string): T | undefined;
  meta<T = unknown>(path: string): T | undefined;
  /** Returns the value at path as a plain object/array. Parses string values with JSON.parse. */
  json<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>(path: string): T | undefined;
  /** Returns the value at path as a PEM string, normalizing literal \n sequences to real newlines. */
  pem(path: string): string | undefined;
  inspect(key: LogicalKey): ReturnType<CnosRuntime['inspect']>;
  toNamespace(namespace: string): ReturnType<CnosRuntime['toNamespace']>;
  toEnv(options?: Parameters<CnosRuntime['toEnv']>[0]): ReturnType<CnosRuntime['toEnv']>;
  toPublicEnv(
    options?: Parameters<CnosRuntime['toPublicEnv']>[0],
  ): ReturnType<CnosRuntime['toPublicEnv']>;
  format(message: string): string;
  log(message: string): string;
  loadProjection(source: string, options?: CnosSingletonProjectionOptions): Promise<void>;
  registerRuntimeProvider(namespace: string, provider: Parameters<CnosRuntime['registerRuntimeProvider']>[1]): void;
  registerSecretVaultProvider(factory: SecretVaultProviderFactory): void;
  registerSecretVaultProviders(factories: SecretVaultProviderFactory[]): void;
  registerVarSourceProvider(module: VarSourceProviderModule): void;
  registerVarSourceProviders(modules: VarSourceProviderModule[]): void;
  refreshSecrets(): Promise<void>;
  refreshSecret(key: LogicalKey): Promise<void>;
  /** Read a `var.*` runtime variable through the overlay precedence (runtime -> value.* -> default). */
  var<T = unknown>(path: string): T | undefined;
  /** Runtime variable snapshot (value + metadata) for a `var.*` path. */
  varSnapshot(path: string): ResolvedVarSnapshot;
  /** Per-scope var observability report. Never carries secret material. */
  varStatus(): VarStatusReport;
  /** Refresh a single `var.*` key, honoring the group ttl. Mirrors `refreshSecret`. */
  refreshVar(key: LogicalKey): Promise<void>;
  /** Refresh all prefetch var groups. Mirrors `refreshSecrets`. */
  refreshVars(): Promise<void>;
  /** Subscribe to validated var activations for a key or `var.<group>.*` prefix. */
  watch(keyOrPrefix: string, callback: VarWatchCallback): () => void;
  /** Stop var pollers/timers and release watchers. */
  close(): Promise<void>;
  ready(options?: CnosCreateOptions): Promise<void>;
}

const NOT_READY_MESSAGE = 'CNOS not initialized. Call await cnos.ready() or use cnos run.';

export interface CnosSingletonProjectionOptions {
  secretVaultProviders?: SecretVaultProviderFactory[];
}

let bootstrappedProjection: ServerProjection | undefined;
const singletonRuntimeProviders = new Map<string, RuntimeProvider>();
const singletonSecretVaultProviders = new Map<string, SecretVaultProviderFactory>();
const singletonVarSourceProviders = new Map<string, VarSourceProviderModule>();
const maxProjectionDiscoveryDepth = 8;
const truthyEnvValues = new Set(['1', 'true', 'yes', 'on']);

let explicitServerProjectionPathError: Error | undefined;
let bootstrapGraphEnvError: Error | undefined;
let bootstrapEnvProjectionError: Error | undefined;

function getProcessEnvFlag(env: Record<string, string | undefined>, key: string): boolean {
  const raw = env[key];
  return raw !== undefined && truthyEnvValues.has(raw.toLowerCase());
}

function resolveExplicitProjectionPath(processEnv: Record<string, string | undefined>): string | undefined {
  // --cnos-projection argv flag takes precedence over the env var, matching all other runtimes.
  if (typeof process !== 'undefined') {
    const argv = process.argv ?? [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] ?? '';
      if (arg.startsWith('--cnos-projection=')) {
        const val = arg.slice('--cnos-projection='.length).trim();
        if (val) return path.resolve(val);
      }
      if (arg === '--cnos-projection' && i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('-')) {
        return path.resolve(argv[i + 1] as string);
      }
    }
  }

  const raw = processEnv[CNOS_SERVER_PROJECTION_PATH_ENV_VAR];
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed) return path.resolve(trimmed);
  }

  return undefined;
}

function projectionRequirementMessage(processEnv: Record<string, string | undefined>): string {
  const projectionPath = resolveExplicitProjectionPath(processEnv);
  const hasProjectionPayload = processEnv[CNOS_PROJECTION_ENV_VAR] !== undefined;
  const hasGraphPayload = processEnv[CNOS_GRAPH_ENV_VAR] !== undefined;
  const details = [
    `CNOS server projection required but not found.`,
    `Checked:`,
    `- __CNOS_GRAPH__: ${hasGraphPayload ? 'set' : 'not set'}`,
    `- CNOS_SERVER_PROJECTION_PATH: ${projectionPath ?? 'not set'}`,
    `- __CNOS_PROJECTION__: ${hasProjectionPayload ? 'set' : 'not set'}`,
    `- ancestor discovery from ${process.cwd()}`,
  ];

  if (hasGraphPayload && bootstrapGraphEnvError) {
    details.push(`- __CNOS_GRAPH__ error: ${bootstrapGraphEnvError.message}`);
  }

  if (projectionPath && explicitServerProjectionPathError) {
    details.push(`- CNOS_SERVER_PROJECTION_PATH error: ${explicitServerProjectionPathError.message}`);
  }

  if (hasProjectionPayload && bootstrapEnvProjectionError) {
    details.push(`- __CNOS_PROJECTION__ error: ${bootstrapEnvProjectionError.message}`);
  }

  return details.join('\n');
}

interface ProjectedSecretDescriptor {
  key: string;
  ref: SecretReference & { envVar?: string };
  vaultId: string;
  definitions: VaultDefinition[];
}

function registerSingletonSecretVaultProvider(factory: SecretVaultProviderFactory): void {
  singletonSecretVaultProviders.set(factory.provider, factory);
}

function mergeSecretVaultProviders(
  factories: SecretVaultProviderFactory[] = [],
): SecretVaultProviderFactory[] {
  const merged = new Map(singletonSecretVaultProviders);

  for (const factory of factories) {
    merged.set(factory.provider, factory);
  }

  return Array.from(merged.values());
}

function mergeVarSourceProviders(modules: VarSourceProviderModule[] = []): VarSourceProviderModule[] {
  const merged = new Map<string, VarSourceProviderModule>();

  for (const module of defaultVarSourceProviders()) {
    merged.set(module.transport, module);
  }

  for (const module of singletonVarSourceProviders.values()) {
    merged.set(module.transport, module);
  }

  for (const module of modules) {
    merged.set(module.transport, module);
  }

  return Array.from(merged.values());
}

function getRuntimeOrThrow(): CnosRuntime {
  const runtime = getSingletonRuntime();

  if (!runtime) {
    throw new Error(NOT_READY_MESSAGE);
  }

  return runtime;
}

const startedVarRuntimes = new WeakSet<object>();

/** Kick off var prefetch + pollers once per runtime (projection-bootstrap path). */
async function maybeStartVars(runtime: CnosRuntime): Promise<void> {
  const start = (runtime as { __startVars?: () => Promise<void> }).__startVars;

  if (typeof start === 'function' && !startedVarRuntimes.has(runtime)) {
    startedVarRuntimes.add(runtime);
    await start();
  }
}

function requireLogicalKey<T = unknown>(runtime: CnosRuntime, key: LogicalKey): T {
  return runtime.require<T>(key);
}

function readLogicalKey<T = unknown>(runtime: CnosRuntime, key: LogicalKey): T | undefined {
  return runtime.read<T>(key);
}

function stringifyLogValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
}

function formatMessage(runtime: CnosRuntime, message: string): string {
  return message.replace(/\$\{([^}]+)\}/g, (match, rawKey) => {
    const key = String(rawKey).trim();

    if (!key) {
      return match;
    }

    const value = runtime.read(key);
    return value === undefined ? match : stringifyLogValue(value);
  });
}

function discoverRuntimeNamespacesFromGraph(graph: ResolvedGraph): string[] {
  const configNamespaces = new Set<string>(['value', 'secret', 'meta', 'public']);

  for (const entry of graph.entries.values()) {
    configNamespaces.add(entry.namespace);
  }

  const runtimeNamespaces = new Set<string>();

  for (const entry of graph.entries.values()) {
    if (!isDerivedValue(entry.value)) {
      continue;
    }

    const parsed = parseDerivation(entry.value);

    for (const ref of parsed.refs) {
      const namespace = ref.split('.')[0] ?? '';

      if (!namespace || configNamespaces.has(namespace)) {
        continue;
      }

      runtimeNamespaces.add(namespace);
    }
  }

  return Array.from(runtimeNamespaces).sort((left, right) => left.localeCompare(right));
}

function attachBootstrappedGraph(graph: ResolvedGraph): void {
  if (getSingletonRuntime()) {
    return;
  }

  bootstrappedProjection = undefined;
  const bootstrappedManifest: NormalizedManifest = {
    version: 1,
    project: {
      name: 'bootstrapped',
    },
    workspaces: {
      global: {
        enabled: Boolean(graph.workspace.globalRoot),
        ...(graph.workspace.globalRoot
          ? {
              root: graph.workspace.globalRoot,
            }
          : {}),
        allowWrite: false,
      },
      items: {},
      ...(graph.workspace.workspaceSource === 'implicit'
        ? {}
        : {
            default: graph.workspace.workspaceId,
          }),
    },
    profiles: {
      default: graph.profile,
      resolveFrom: ['default'],
    },
    plugins: {
      loaders: [],
      resolver: 'profile-aware',
      validators: [],
      exporters: [],
      inspectors: [],
    },
    sources: {},
    resolution: {
      precedence: [],
      arrayPolicy: 'replace',
    },
    envMapping: {
      explicit: {},
    },
    public: {
      promote: [],
      frameworks: {},
    },
    namespaces: {},
    runtimeNamespaces: {
      process: {
        description: 'Live process runtime values.',
        serverOnly: true,
        builtIn: true,
      },
      ...Object.fromEntries(
        discoverRuntimeNamespacesFromGraph(graph).map((namespace) => [
          namespace,
          {
            serverOnly: true,
          },
        ]),
      ),
    },
    vaults: {},
    writePolicy: {
      define: {
        defaultProfile: graph.profile,
        targets: {
          value: './values/app.yml',
          secret: './secrets/app.yml',
        },
      },
    },
    schema: {},
  };
  const runtimeProviders = createDefaultRuntimeProviders(bootstrappedManifest, process.env);
  for (const [namespace, provider] of singletonRuntimeProviders) {
    registerRuntimeProvider(bootstrappedManifest, runtimeProviders, namespace, provider);
  }
  const derivedSupport = createDerivedRuntimeSupport(graph, bootstrappedManifest, runtimeProviders);

  const resolveProjectedSourceKey = (key: string): string => {
    if (!key.startsWith('public.')) {
      return key;
    }

    const promotedFrom = graph.entries.get(key)?.winner.metadata?.promotedFrom;

    if (typeof promotedFrom === 'string') {
      return promotedFrom;
    }

    const fallback = `value.${key.slice('public.'.length)}`;
    return graph.entries.has(fallback) ? fallback : key;
  };

  const runtime = {
    manifest: bootstrappedManifest,
    plugins: [],
    graph,
    read<T = unknown>(key: LogicalKey): T | undefined {
      return derivedSupport.read(key, (ref) => readValue(graph, ref)) as T | undefined;
    },
    require<T = unknown>(key: LogicalKey): T {
      const value = this.read<T>(key);

      if (value === undefined) {
        return requireValue(graph, key);
      }

      return value;
    },
    readOr<T>(key: LogicalKey, fallback: T): T {
      const value = this.read<T>(key);
      return (value === undefined ? fallback : value) as T;
    },
    value<T = unknown>(path: string): T | undefined {
      return readValue(graph, toLogicalKey('value', path));
    },
    secret<T = unknown>(path: string): T | undefined {
      return readValue(graph, toLogicalKey('secret', path));
    },
    meta<T = unknown>(path: string): T | undefined {
      return readValue(graph, toLogicalKey('meta', path));
    },
    toNamespace(namespace) {
      return toNamespaceObject(graph, namespace, (key) => this.read(key));
    },
    toEnv(options) {
      return toEnv(graph, bootstrappedManifest, options, {
        read: (key) => this.read(key),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(key),
      });
    },
    toPublicEnv(options) {
      return toPublicEnv(graph, bootstrappedManifest, options, {
        read: (key) =>
          derivedSupport.toConcreteValue(resolveProjectedSourceKey(key), (ref) => readValue(graph, ref), 'public'),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(resolveProjectedSourceKey(key)),
      });
    },
    inspect(key: LogicalKey) {
      return inspectValue(graph, key, {
        read: (ref) => this.read(ref),
        describeDerived: (ref) => derivedSupport.describe(ref, (candidate) => readValue(graph, candidate)),
      });
    },
    toObject() {
      return toNamespaceObject(graph, undefined, (key) => this.read(key));
    },
    toServerProjection() {
      throw new Error('CNOS graph bootstrap payload does not support server projection export.');
    },
    registerRuntimeProvider(namespace, provider) {
      registerRuntimeProvider(bootstrappedManifest, runtimeProviders, namespace, provider);
      singletonRuntimeProviders.set(namespace, provider);
    },
    async refreshSecrets() {
      return;
    },
    async refreshSecret() {
      return;
    },
  } satisfies CnosRuntime;

  setSingletonRuntime(runtime);
  setBootstrappedSecretHydrationRequired(graphRequiresSecretHydration(graph));
}

function toBootstrappedManifest(
  graph: ResolvedGraph,
  runtimeNamespaces: string[] = [],
  vaults: ServerProjection['vaults'] = {},
): NormalizedManifest {
  return {
    version: 1,
    project: {
      name: 'bootstrapped',
    },
    workspaces: {
      global: {
        enabled: false,
        allowWrite: false,
      },
      items: {},
      ...(graph.workspace.workspaceSource === 'implicit'
        ? {}
        : {
            default: graph.workspace.workspaceId,
          }),
    },
    profiles: {
      default: graph.profile,
      resolveFrom: ['default'],
    },
    plugins: {
      loaders: [],
      resolver: 'profile-aware',
      validators: [],
      exporters: [],
      inspectors: [],
    },
    sources: {},
    resolution: {
      precedence: [],
      arrayPolicy: 'replace',
    },
    envMapping: {
      explicit: {},
    },
    public: {
      promote: [],
      frameworks: {},
    },
    namespaces: {
      value: { kind: 'data', shareable: true },
      secret: { kind: 'data', shareable: false, sensitive: true },
      meta: { kind: 'system', shareable: false, readonly: true },
      process: { kind: 'system', shareable: false, readonly: true },
      public: { kind: 'projection', shareable: true, readonly: true, source: 'promote' },
    },
    runtimeNamespaces: {
      process: {
        description: 'Live process runtime values.',
        serverOnly: true,
        builtIn: true,
      },
      ...Object.fromEntries(
        runtimeNamespaces
          .filter((namespace) => namespace !== 'process')
          .map((namespace) => [
            namespace,
            {
              serverOnly: true,
            },
          ]),
      ),
    },
    vaults,
    writePolicy: {
      define: {
        defaultProfile: graph.profile,
        targets: {
          value: './values/app.yml',
          secret: './secrets/app.yml',
        },
      },
    },
    schema: {},
  };
}

function graphFromProjection(projection: ServerProjection): ResolvedGraph {
  const entries = new Map<string, ResolvedEntry>();
  const now = projection.resolvedAt;
  const explicitNamespaces = new Set(['flags', 'config', 'process', ...(projection.meta.namespaces ?? [])]);

  for (const [key, value] of Object.entries(projection.values)) {
    const firstSegment = key.split('.')[0] ?? '';
    const logicalKey =
      key.startsWith('value.') || key.startsWith('public.') || explicitNamespaces.has(firstSegment)
        ? key
        : `value.${key}`;
    const namespace = logicalKey.slice(0, logicalKey.indexOf('.'));
    const winner = {
      key: logicalKey,
      value,
      namespace,
      sourceId: 'server-projection',
      pluginId: 'cnos',
      workspaceId: projection.workspace,
      profile: projection.profile,
    };
    entries.set(logicalKey, {
      key: logicalKey,
      value,
      namespace,
      winner,
      overridden: [],
    });
  }

  for (const [key, formula] of Object.entries(projection.derived)) {
    const firstSegment = key.split('.')[0] ?? '';
    const logicalKey =
      key.startsWith('value.') || key.startsWith('public.') || explicitNamespaces.has(firstSegment)
        ? key
        : `value.${key}`;
    const namespace = logicalKey.slice(0, logicalKey.indexOf('.'));
    const winner = {
      key: logicalKey,
      value: {
        $derive: {
          expr: formula.expr,
        },
      },
      namespace,
      sourceId: 'server-projection',
      pluginId: 'cnos',
      workspaceId: projection.workspace,
      profile: projection.profile,
    };

    entries.set(logicalKey, {
      key: logicalKey,
      value: winner.value,
      namespace,
      winner,
      overridden: [],
    });
  }

  for (const [key, ref] of Object.entries(projection.secretRefs)) {
    const logicalKey = `secret.${key}`;
    entries.set(logicalKey, {
      key: logicalKey,
      value: ref,
      namespace: 'secret',
      winner: {
        key: logicalKey,
        value: ref,
        namespace: 'secret',
        sourceId: 'server-projection',
        pluginId: 'cnos',
        workspaceId: projection.workspace,
        profile: projection.profile,
      },
      overridden: [],
    });
  }

  for (const key of projection.publicKeys) {
    const valueKey = Object.prototype.hasOwnProperty.call(projection.values, key) ? key : `value.${key}`;
    const publicKey = `public.${key}`;
    const sourceEntry = entries.get(valueKey);

    if (!sourceEntry) {
      continue;
    }

    entries.set(publicKey, {
      key: publicKey,
      value: sourceEntry.value,
      namespace: 'public',
      winner: {
        key: publicKey,
        value: sourceEntry.value,
        namespace: 'public',
        sourceId: 'server-projection',
        pluginId: 'cnos',
        workspaceId: projection.workspace,
        profile: projection.profile,
        metadata: {
          promotedFrom: valueKey,
        },
      },
      overridden: [],
    });
  }

  entries.set('meta.profile', {
    key: 'meta.profile',
    value: projection.profile,
    namespace: 'meta',
    winner: {
      key: 'meta.profile',
      value: projection.profile,
      namespace: 'meta',
      sourceId: 'server-projection',
      pluginId: 'cnos',
      workspaceId: projection.workspace,
      profile: projection.profile,
    },
    overridden: [],
  });

  return {
    entries,
    profile: projection.profile,
    resolvedAt: now,
    profileSource: 'manifest-default',
    workspace: {
      workspaceId: projection.workspace,
      workspaceSource: 'implicit',
      workspaceChain: [projection.workspace],
      workspaceRoots: [],
    },
  };
}

function vaultDefinitionFromProjection(
  manifest: NormalizedManifest,
  projection: ServerProjection,
  key: string,
  ref: SecretReference & { envVar?: string },
): VaultDefinition {
  assertSecretRefVaultProviderCompatible(manifest, ref, key);
  const vaultId = ref.vault ?? 'default';
  const projected = projection.vaults?.[vaultId];
  const mapping = {
    ...(projected?.mapping ?? {}),
    ...(ref.envVar ? { [ref.envVar]: ref.ref } : {}),
  };

  return {
    provider: projected?.provider ?? ref.provider ?? 'local',
    ...(projected?.auth ? { auth: projected.auth } : {}),
    ...(Object.keys(mapping).length > 0 ? { mapping } : {}),
    ...(projected?.fallback ? { fallback: projected.fallback } : {}),
  };
}

function attachBootstrappedProjection(
  projection: ServerProjection,
  force = false,
  options: CnosSingletonProjectionOptions = {},
): void {
  if (getSingletonRuntime() && !force) {
    return;
  }

  bootstrappedProjection = projection;
  const graph = graphFromProjection(projection);
  const manifest = toBootstrappedManifest(graph, projection.runtimeNamespaces, projection.vaults ?? {});
  const hydratedSecrets = new Map<string, unknown>();
  const secretVaultProviders = mergeSecretVaultProviders(options.secretVaultProviders);
  const runtimeProviders = createDefaultRuntimeProviders(manifest, process.env);
  for (const [namespace, provider] of singletonRuntimeProviders) {
    registerRuntimeProvider(manifest, runtimeProviders, namespace, provider);
  }
  const derivedSupport = createDerivedRuntimeSupport(graph, manifest, runtimeProviders);
  const resolveProjectedSourceKey = (key: string): string => {
    if (!key.startsWith('public.')) {
      return key;
    }

    const promotedFrom = graph.entries.get(key)?.winner.metadata?.promotedFrom;

    if (typeof promotedFrom === 'string') {
      return promotedFrom;
    }

    const fallback = `value.${key.slice('public.'.length)}`;
    return graph.entries.has(fallback) ? fallback : key;
  };

  const projectedDescriptorForKey = (key: string): ProjectedSecretDescriptor | undefined => {
    const entry = graph.entries.get(key);

    if (!entry || entry.namespace !== 'secret') {
      return undefined;
    }

    const ref = projection.secretRefs[key.slice('secret.'.length)];

    if (!ref) {
      return undefined;
    }

    const definition = vaultDefinitionFromProjection(manifest, projection, key, ref);
    return {
      key,
      ref,
      vaultId: ref.vault ?? 'default',
      definitions: [definition, ...(definition.fallback ?? [])],
    };
  };

  const runtimeDefinitionForCandidate = (candidate: VaultDefinition): VaultDefinition => ({
    provider: candidate.provider,
    ...(candidate.auth ? { auth: candidate.auth } : {}),
    ...(candidate.mapping ? { mapping: candidate.mapping } : {}),
  });

  const hydrateProjectedSecrets = async (keys?: string[]): Promise<void> => {
    const requestedKeys = keys ?? Object.keys(projection.secretRefs).map((segment) => `secret.${segment}`);
    let remaining = requestedKeys
      .filter((key) => !hydratedSecrets.has(key))
      .map((key) => projectedDescriptorForKey(key))
      .filter((descriptor): descriptor is ProjectedSecretDescriptor => Boolean(descriptor));
    const lastErrors = new Map<string, unknown>();
    let candidateIndex = 0;

    while (remaining.length > 0) {
      const grouped = new Map<string, {
        vaultId: string;
        definition: VaultDefinition;
        descriptors: ProjectedSecretDescriptor[];
      }>();
      const exhausted: ProjectedSecretDescriptor[] = [];

      for (const descriptor of remaining) {
        const candidate = descriptor.definitions[candidateIndex];

        if (!candidate) {
          exhausted.push(descriptor);
          continue;
        }

        const groupKey = `${descriptor.vaultId}\0${candidate.provider}`;
        const group = grouped.get(groupKey) ?? {
          vaultId: descriptor.vaultId,
          definition: candidate,
          descriptors: [],
        };
        group.descriptors.push(descriptor);
        grouped.set(groupKey, group);
      }

      if (grouped.size === 0) {
        remaining = exhausted;
        break;
      }

      const unresolved = [...exhausted];

      for (const group of grouped.values()) {
        const runtimeDefinition = runtimeDefinitionForCandidate(group.definition);

        try {
          const provider = createSecretVaultProvider(
            group.vaultId,
            runtimeDefinition,
            process.env,
            secretVaultProviders,
          );
          const auth = await resolveVaultAuth(group.vaultId, runtimeDefinition, process.env);
          await provider.authenticate(auth);
          const refs = Array.from(new Set(group.descriptors.map((descriptor) => descriptor.ref.ref)))
            .sort((left, right) => left.localeCompare(right));
          const values = await provider.batchGet(refs);

          for (const descriptor of group.descriptors) {
            const value = values.get(descriptor.ref.ref);

            if (value !== undefined) {
              hydratedSecrets.set(descriptor.key, value);
              lastErrors.delete(descriptor.key);
            } else {
              unresolved.push(descriptor);
            }
          }
        } catch (error) {
          for (const descriptor of group.descriptors) {
            lastErrors.set(descriptor.key, error);
            unresolved.push(descriptor);
          }
        }
      }

      remaining = unresolved.filter((descriptor) => !hydratedSecrets.has(descriptor.key));
      candidateIndex += 1;
    }

    for (const descriptor of remaining) {
      const error = lastErrors.get(descriptor.key);

      if (error) {
        throw error;
      }

      hydratedSecrets.set(descriptor.key, undefined);
    }
  };

  const baseEntryRead = (ref: string): unknown => {
    const entry = graph.entries.get(ref);

    if (!entry) {
      return undefined;
    }

    if (entry.namespace === 'secret') {
      return hydratedSecrets.get(ref);
    }

    return entry.value;
  };

  // Wire the var runtime only when the projection actually declares var sources + groups.
  const hasVarBlocks =
    Boolean(projection.varSources) &&
    Boolean(projection.vars) &&
    Object.keys(projection.varSources ?? {}).length > 0 &&
    Object.keys(projection.vars ?? {}).length > 0;

  if (hasVarBlocks) {
    manifest.varSources = projection.varSources ?? {};
    manifest.vars = projection.vars ?? {};
    manifest.documents = projection.documents ?? {};
  }

  const resolveVarSecretForProjection = async (ref: string): Promise<string> => {
    if (!hydratedSecrets.has(ref)) {
      await hydrateProjectedSecrets([ref]);
    }
    const value = hydratedSecrets.get(ref);
    if (value === undefined) {
      throw new Error(`Cannot resolve var source auth secret "${ref}".`);
    }
    return typeof value === 'string' ? value : String(value);
  };

  const varSupport = hasVarBlocks
    ? createSingletonVarSupport({
        varSources: projection.varSources ?? {},
        vars: projection.vars ?? {},
        documents: projection.documents ?? {},
        schema: {},
        manifest,
        providerModules: mergeVarSourceProviders(),
        resolveSecret: resolveVarSecretForProjection,
        readStaticValue: (valueKey) => derivedSupport.read(valueKey, baseEntryRead),
      })
    : undefined;

  const runtime = {
    manifest,
    plugins: [],
    graph,
    read<T = unknown>(key: LogicalKey): T | undefined {
      if (varSupport && key.startsWith('var.')) {
        return varSupport.readVar(key) as T | undefined;
      }
      return derivedSupport.read(key, (ref) =>
        varSupport && ref.startsWith('var.') ? varSupport.readVar(ref, false) : baseEntryRead(ref),
      ) as T | undefined;
    },
    var<T = unknown>(path: string): T | undefined {
      return varSupport ? (varSupport.readVar(`var.${path}`) as T | undefined) : undefined;
    },
    varSnapshot(path: string): ResolvedVarSnapshot {
      return (
        varSupport?.varSnapshot(`var.${path}`) ?? { value: undefined, source: 'default', freshness: 'fresh' }
      );
    },
    varStatus(): VarStatusReport {
      return varSupport?.manager.status() ?? {};
    },
    async refreshVar(key: LogicalKey): Promise<void> {
      await varSupport?.manager.refreshVar(key);
    },
    async refreshVars(): Promise<void> {
      await varSupport?.manager.refreshVars();
    },
    watch(keyOrPrefix: string, callback: VarWatchCallback): () => void {
      return varSupport?.manager.watch(keyOrPrefix, callback) ?? (() => undefined);
    },
    async close(): Promise<void> {
      await varSupport?.manager.close();
    },
    require<T = unknown>(key: LogicalKey): T {
      const value = this.read<T>(key);

      if (value === undefined) {
        throw new Error(`Missing required CNOS config key: ${key}`);
      }

      return value;
    },
    readOr<T>(key: LogicalKey, fallback: T): T {
      return this.read<T>(key) ?? fallback;
    },
    value<T = unknown>(segment: string): T | undefined {
      return this.read<T>(toLogicalKey('value', segment));
    },
    secret<T = unknown>(segment: string): T | undefined {
      return this.read<T>(toLogicalKey('secret', segment));
    },
    meta<T = unknown>(segment: string): T | undefined {
      return this.read<T>(toLogicalKey('meta', segment));
    },
    inspect(key: LogicalKey) {
      return inspectValue(
        {
          ...graph,
          entries: new Map(
            Array.from(graph.entries.entries()).map(([entryKey, existing]) => [
              entryKey,
              entryKey === key && existing.namespace === 'secret' && hydratedSecrets.has(entryKey)
                ? { ...existing, value: hydratedSecrets.get(entryKey) }
                : existing,
            ]),
          ),
        },
        key,
        {
          read: (ref) => this.read(ref),
          describeDerived: (ref) =>
            derivedSupport.describe(ref, (candidate) => {
              const entry = graph.entries.get(candidate);

              if (!entry) {
                return undefined;
              }

              if (entry.namespace === 'secret') {
                return hydratedSecrets.get(candidate);
              }

              return entry.value;
            }),
        },
      );
    },
    toObject() {
      return toNamespaceObject(graph, undefined, (key) => this.read(key));
    },
    toNamespace(namespace: string) {
      return toNamespaceObject(graph, namespace, (key) => this.read(key));
    },
    toEnv(options) {
      return toEnv(graph, manifest, options, {
        read: (key) => this.read(key),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(key),
      });
    },
    toPublicEnv(options) {
      return toPublicEnv(graph, manifest, options, {
        read: (key) =>
          derivedSupport.toConcreteValue(
            resolveProjectedSourceKey(key),
            (ref) => {
              const entry = graph.entries.get(ref);

              if (!entry) {
                return undefined;
              }

              if (entry.namespace === 'secret') {
                return hydratedSecrets.get(ref);
              }

              return entry.value;
            },
            'public',
          ),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(resolveProjectedSourceKey(key)),
      });
    },
    toServerProjection() {
      return projection;
    },
    registerRuntimeProvider(namespace, provider) {
      registerRuntimeProvider(manifest, runtimeProviders, namespace, provider);
      singletonRuntimeProviders.set(namespace, provider);
    },
    async refreshSecrets() {
      const keys = Object.keys(projection.secretRefs).map((segment) => `secret.${segment}`);
      for (const key of keys) {
        hydratedSecrets.delete(key);
      }
      await hydrateProjectedSecrets(keys);
    },
    async refreshSecret(key: LogicalKey) {
      hydratedSecrets.delete(key);
      await hydrateProjectedSecrets([key]);
    },
  } satisfies CnosRuntime;

  if (varSupport) {
    Object.defineProperty(runtime, '__startVars', { value: () => varSupport.start(), enumerable: false });
    Object.defineProperty(runtime, '__ingestVar', {
      value: (sourceId: string, scope: string, batch: VarSnapshotBatch) =>
        varSupport.ingest(sourceId, scope, batch),
      enumerable: false,
    });
    Object.defineProperty(runtime, '__varSource', {
      value: (sourceId: string) => varSupport.varSource(sourceId),
      enumerable: false,
    });
    Object.defineProperty(runtime, '__resolveVarSecret', {
      value: (ref: string) => varSupport.resolveSecret(ref),
      enumerable: false,
    });
  }

  setSingletonRuntime(runtime);
  setBootstrappedSecretHydrationRequired(Object.keys(projection.secretRefs).length > 0);
}

function bootstrapFromProcessEnv(): void {
  if (typeof process === 'undefined') {
    return;
  }

  if (process.env[CNOS_GRAPH_ENV_VAR] !== undefined) {
    try {
      const graph = readRuntimeGraphFromEnv(process.env);

      if (graph) {
        bootstrapGraphEnvError = undefined;
        attachBootstrappedGraph(graph);
        return;
      }

      bootstrapGraphEnvError = new Error('Invalid CNOS runtime bootstrap payload in __CNOS_GRAPH__.');
    } catch (error) {
      bootstrapGraphEnvError =
        error instanceof Error ? error : new Error('Invalid CNOS runtime bootstrap payload in __CNOS_GRAPH__.');
    }

    return;
  }

  if (process.env[CNOS_PROJECTION_ENV_VAR] !== undefined) {
    try {
      const projection = readServerProjectionFromEnv(process.env);

      if (projection) {
        bootstrapEnvProjectionError = undefined;
        attachBootstrappedProjection(projection);
        return;
      }

      bootstrapEnvProjectionError = new Error('Invalid CNOS server projection payload in __CNOS_PROJECTION__.');
    } catch (error) {
      bootstrapEnvProjectionError =
        error instanceof Error
          ? error
          : new Error('Invalid CNOS server projection payload in __CNOS_PROJECTION__.');
    }

    return;
  }

  bootstrapGraphEnvError = undefined;
  bootstrapEnvProjectionError = undefined;
}

function discoverProjectionPathSync(): string | undefined {
  const cwd = process.cwd();
  const directCandidates = [
    path.join(cwd, '.cnos-server.json'),
  ];

  for (const candidate of directCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  let current = cwd;

  for (let depth = 0; depth <= maxProjectionDiscoveryDepth; depth += 1) {
    const rcCandidate = path.join(current, '.cnosrc.yml');

    if (existsSync(rcCandidate)) {
      const projectionCandidate = path.join(current, '.cnos-server.json');

      if (existsSync(projectionCandidate)) {
        return projectionCandidate;
      }
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return undefined;
}

function bootstrapFromProjectionFile(): void {
  if (getSingletonRuntime() || bootstrapGraphEnvError || bootstrapEnvProjectionError) {
    return;
  }

  const processEnv = process.env;
  const projectionPath = resolveExplicitProjectionPath(processEnv);

  try {
    if (projectionPath) {
      const projection = deserializeServerProjection(readFileSync(projectionPath, 'utf8'));
      attachBootstrappedProjection(projection);
      return;
    }

    const discoveryPath = discoverProjectionPathSync();

    if (!discoveryPath) {
      return;
    }

    const projection = deserializeServerProjection(readFileSync(discoveryPath, 'utf8'));
    attachBootstrappedProjection(projection);
  } catch (error) {
    if (projectionPath) {
      explicitServerProjectionPathError =
        error instanceof Error
          ? error
          : new Error(`Unable to load CNOS server projection from ${projectionPath}.`);
    }
    // Ignore malformed auto-discovery projection artifacts here; ready() will surface explicit errors.
  }
}

function getBootstrapFailure(processEnv: Record<string, string | undefined>): Error | undefined {
  if (getSingletonRuntime()) {
    return undefined;
  }

  if (bootstrapGraphEnvError) {
    return bootstrapGraphEnvError;
  }

  if (bootstrapEnvProjectionError) {
    return bootstrapEnvProjectionError;
  }

  if (explicitServerProjectionPathError) {
    return explicitServerProjectionPathError;
  }

  if (getProcessEnvFlag(processEnv, CNOS_REQUIRE_SERVER_PROJECTION_ENV_VAR)) {
    return new Error(projectionRequirementMessage(processEnv));
  }

  return undefined;
}

function bootstrapDynamic(): void {
  if (getSingletonRuntime()) {
    return;
  }

  if (typeof process === 'undefined') {
    return;
  }

  // Dynamic mode only suppresses projection-not-found. If a higher-priority source
  // (__CNOS_GRAPH__, __CNOS_PROJECTION__, or an explicit path) was attempted but failed,
  // surface that error rather than silently falling through to a dynamic stub.
  if (bootstrapGraphEnvError || bootstrapEnvProjectionError || explicitServerProjectionPathError) {
    return;
  }

  const envFlag = process.env['CNOS_DYNAMIC'];
  const argFlag = (process.argv ?? []).some((a) => {
    if (a === '--cnos-dynamic') return true;
    if (a.startsWith('--cnos-dynamic=')) {
      const val = a.slice('--cnos-dynamic='.length).toLowerCase();
      return val === '1' || val === 'true' || val === 'yes';
    }
    return false;
  });
  const isDynamic =
    argFlag || (envFlag !== undefined && ['1', 'true', 'yes'].includes(envFlag.toLowerCase()));

  if (!isDynamic) {
    return;
  }

  const dynamicProjection: ServerProjection = {
    version: 1,
    workspace: 'base',
    profile: '',
    resolvedAt: '',
    configHash: '',
    values: {},
    derived: {},
    secretRefs: {},
    publicKeys: [],
    runtimeNamespaces: ['process'],
    overrides: {},
    meta: { workspace: 'base', profile: '', cnos_version: 'dynamic' },
  };

  attachBootstrappedProjection(dynamicProjection);
}

bootstrapFromProcessEnv();
bootstrapFromProjectionFile();
bootstrapDynamic();

const cnos = Object.assign(
  (<T = unknown>(key: LogicalKey) => readLogicalKey<T>(getRuntimeOrThrow(), key)) as CnosSingleton,
  {
    read<T = unknown>(key: LogicalKey): T | undefined {
      return readLogicalKey(getRuntimeOrThrow(), key);
    },
    require<T = unknown>(key: LogicalKey): T {
      return requireLogicalKey(getRuntimeOrThrow(), key);
    },
    readOr<T>(key: LogicalKey, fallback: T): T {
      return getRuntimeOrThrow().readOr(key, fallback);
    },
    value<T = unknown>(path: string): T | undefined {
      return getRuntimeOrThrow().value(path);
    },
    secret<T = unknown>(path: string): T | undefined {
      return getRuntimeOrThrow().secret(path);
    },
    meta<T = unknown>(path: string): T | undefined {
      return getRuntimeOrThrow().meta(path);
    },
    json<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>(path: string): T | undefined {
      const raw = getRuntimeOrThrow().value(path);
      if (raw === undefined) return undefined;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw) as T; } catch { return undefined; }
      }
      return raw as T;
    },
    pem(path: string): string | undefined {
      const raw = getRuntimeOrThrow().value<string>(path) ?? getRuntimeOrThrow().secret<string>(path);
      if (typeof raw !== 'string') return undefined;
      return raw.replace(/\\n/g, '\n');
    },
    inspect(key: LogicalKey) {
      return getRuntimeOrThrow().inspect(key);
    },
    toNamespace(namespace: string) {
      return getRuntimeOrThrow().toNamespace(namespace);
    },
    toEnv(options: Parameters<CnosRuntime['toEnv']>[0]) {
      return getRuntimeOrThrow().toEnv(options);
    },
    toPublicEnv(options: Parameters<CnosRuntime['toPublicEnv']>[0]) {
      return getRuntimeOrThrow().toPublicEnv(options);
    },
    format(message: string): string {
      return formatMessage(getRuntimeOrThrow(), message);
    },
    log(message: string): string {
      const formatted = formatMessage(getRuntimeOrThrow(), message);
      console.log(formatted);
      return formatted;
    },
    async loadProjection(source: string, options: CnosSingletonProjectionOptions = {}): Promise<void> {
      const resolvedSource = path.resolve(source);
      const projection = deserializeServerProjection(readFileSync(resolvedSource, 'utf8'));
      attachBootstrappedProjection(projection, true, options);
      setBootstrappedSecretHydrationRequired(Object.keys(projection.secretRefs).length > 0);
    },
    registerRuntimeProvider(namespace: string, provider: Parameters<CnosRuntime['registerRuntimeProvider']>[1]): void {
      getRuntimeOrThrow().registerRuntimeProvider(namespace, provider);
      singletonRuntimeProviders.set(namespace, provider);
    },
    registerSecretVaultProvider(factory: SecretVaultProviderFactory): void {
      registerSingletonSecretVaultProvider(factory);
    },
    registerSecretVaultProviders(factories: SecretVaultProviderFactory[]): void {
      for (const factory of factories) {
        registerSingletonSecretVaultProvider(factory);
      }
    },
    registerVarSourceProvider(module: VarSourceProviderModule): void {
      singletonVarSourceProviders.set(module.transport, module);
    },
    registerVarSourceProviders(modules: VarSourceProviderModule[]): void {
      for (const module of modules) {
        singletonVarSourceProviders.set(module.transport, module);
      }
    },
    var<T = unknown>(path: string): T | undefined {
      return getRuntimeOrThrow().var?.<T>(path);
    },
    varSnapshot(path: string): ResolvedVarSnapshot {
      return getRuntimeOrThrow().varSnapshot?.(path) ?? { value: undefined, source: 'default', freshness: 'fresh' };
    },
    varStatus(): VarStatusReport {
      return getRuntimeOrThrow().varStatus?.() ?? {};
    },
    async refreshVar(key: LogicalKey): Promise<void> {
      await getRuntimeOrThrow().refreshVar?.(key);
    },
    async refreshVars(): Promise<void> {
      await getRuntimeOrThrow().refreshVars?.();
    },
    watch(keyOrPrefix: string, callback: VarWatchCallback): () => void {
      return getRuntimeOrThrow().watch?.(keyOrPrefix, callback) ?? (() => undefined);
    },
    async close(): Promise<void> {
      await getRuntimeOrThrow().close?.();
    },
    async refreshSecrets(): Promise<void> {
      await getRuntimeOrThrow().refreshSecrets();
      setBootstrappedSecretHydrationRequired(false);
    },
    async refreshSecret(key: LogicalKey): Promise<void> {
      await getRuntimeOrThrow().refreshSecret(key);
    },
    async ready(options: CnosCreateOptions = {}): Promise<void> {
      const runtime = getSingletonRuntime();
      const processEnv = process.env;
      const secretVaultProviders = mergeSecretVaultProviders(options.secretVaultProviders);
      const bootstrapFailure = getBootstrapFailure(processEnv);

      if (runtime === undefined && bootstrapFailure) {
        throw new Error(projectionRequirementMessage(processEnv));
      }

      if (runtime && getBootstrappedSecretHydrationRequired()) {
        const runtimeToHydrate =
          bootstrappedProjection && secretVaultProviders.length > 0
            ? (attachBootstrappedProjection(bootstrappedProjection, true, {
                secretVaultProviders,
              }),
              getRuntimeOrThrow())
            : runtime;

        await runtimeToHydrate.refreshSecrets();
        setBootstrappedSecretHydrationRequired(false);
        await maybeStartVars(runtimeToHydrate);
        return;
      }

      if (runtime && !getBootstrappedSecretHydrationRequired()) {
        await maybeStartVars(runtime);
        return;
      }

      const existing = getSingletonReady();

      if (existing && !getBootstrappedSecretHydrationRequired()) {
        await existing;
        return;
      }

      const readyPromise = createCnos({
        ...options,
        secretVaultProviders,
        varSourceProviders: mergeVarSourceProviders(options.varSourceProviders),
      }).then((runtime) => {
        setSingletonRuntime(runtime);
        setBootstrappedSecretHydrationRequired(false);
        return runtime;
      });

      setSingletonReady(readyPromise);
      await readyPromise;
    },
  },
);

export default cnos;
