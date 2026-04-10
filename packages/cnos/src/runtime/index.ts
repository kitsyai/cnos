import {
  inspectValue,
  readOrValue,
  readValue,
  requireValue,
  toEnv,
  toLogicalKey,
  toNamespaceObject,
  toPublicEnv,
  type CnosRuntime,
  type LogicalKey,
  type NormalizedManifest,
  type ResolvedGraph,
} from '@kitsy/cnos-core';

import { createCnos } from '../createCnos.js';
import { graphRequiresSecretHydration, readRuntimeGraphFromEnv } from './bootstrap.js';
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
  inspect(key: LogicalKey): ReturnType<CnosRuntime['inspect']>;
  toNamespace(namespace: string): ReturnType<CnosRuntime['toNamespace']>;
  toEnv(options?: Parameters<CnosRuntime['toEnv']>[0]): ReturnType<CnosRuntime['toEnv']>;
  toPublicEnv(
    options?: Parameters<CnosRuntime['toPublicEnv']>[0],
  ): ReturnType<CnosRuntime['toPublicEnv']>;
  format(message: string): string;
  log(message: string): string;
  ready(): Promise<void>;
}

const NOT_READY_MESSAGE = 'CNOS not initialized. Call await cnos.ready() or use cnos run.';

function getRuntimeOrThrow(): CnosRuntime {
  const runtime = getSingletonRuntime();

  if (!runtime) {
    throw new Error(NOT_READY_MESSAGE);
  }

  return runtime;
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

function attachBootstrappedGraph(graph: ResolvedGraph): void {
  if (getSingletonRuntime()) {
    return;
  }

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

  const runtime = {
    manifest: bootstrappedManifest,
    plugins: [],
    graph,
    read<T = unknown>(key: LogicalKey): T | undefined {
      return readValue(graph, key);
    },
    require<T = unknown>(key: LogicalKey): T {
      return requireValue(graph, key);
    },
    readOr<T>(key: LogicalKey, fallback: T): T {
      return readOrValue(graph, key, fallback);
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
      return toNamespaceObject(graph, namespace);
    },
    toEnv(options) {
      return toEnv(graph, bootstrappedManifest, options);
    },
    toPublicEnv(options) {
      return toPublicEnv(graph, bootstrappedManifest, options);
    },
    inspect(key: LogicalKey) {
      return inspectValue(graph, key);
    },
    toObject() {
      return toNamespaceObject(graph);
    },
  } satisfies CnosRuntime;

  setSingletonRuntime(runtime);
  setBootstrappedSecretHydrationRequired(graphRequiresSecretHydration(graph));
}

function bootstrapFromProcessEnv(): void {
  if (typeof process === 'undefined') {
    return;
  }

  try {
    const graph = readRuntimeGraphFromEnv(process.env);

    if (graph) {
      attachBootstrappedGraph(graph);
    }
  } catch {
    // Ignore malformed bootstrap payloads here; explicit ready() will surface real resolution errors.
  }
}

bootstrapFromProcessEnv();

const cnos = Object.assign(
  (<T = unknown>(key: LogicalKey) => readValue<T>(getRuntimeOrThrow().graph, key)) as CnosSingleton,
  {
    read<T = unknown>(key: LogicalKey): T | undefined {
      return readValue(getRuntimeOrThrow().graph, key);
    },
    require<T = unknown>(key: LogicalKey): T {
      return requireValue(getRuntimeOrThrow().graph, key);
    },
    readOr<T>(key: LogicalKey, fallback: T): T {
      return readOrValue(getRuntimeOrThrow().graph, key, fallback);
    },
    value<T = unknown>(path: string): T | undefined {
      return readValue(getRuntimeOrThrow().graph, toLogicalKey('value', path));
    },
    secret<T = unknown>(path: string): T | undefined {
      return readValue(getRuntimeOrThrow().graph, toLogicalKey('secret', path));
    },
    meta<T = unknown>(path: string): T | undefined {
      return readValue(getRuntimeOrThrow().graph, toLogicalKey('meta', path));
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
    async ready(): Promise<void> {
      if (getSingletonRuntime() && !getBootstrappedSecretHydrationRequired()) {
        return;
      }

      const existing = getSingletonReady();

      if (existing && !getBootstrappedSecretHydrationRequired()) {
        await existing;
        return;
      }

      const readyPromise = createCnos().then((runtime) => {
        setSingletonRuntime(runtime);
        return runtime;
      });

      setSingletonReady(readyPromise);
      await readyPromise;
    },
  },
);

export default cnos;
