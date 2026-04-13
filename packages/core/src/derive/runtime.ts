import {
  CnosDerivedResolutionError,
  CnosRuntimeProviderError,
} from '../errors.js';
import type {
  DerivedFormula,
  DerivedValue,
  ParsedDerivation,
  RuntimeProvider,
} from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { ResolvedGraph } from '../types/core.js';
import { detectDerivationCycles } from './depGraph.js';
import { evaluateDerivation, isDerivedValue, parseDerivation } from './evaluator.js';
import { validateDerivedTargetNamespace, validateParsedDerivation } from './validate.js';

interface DerivedEntry {
  key: string;
  namespace: string;
  value: DerivedValue;
  parsed: ParsedDerivation;
}

export interface DerivedDescriptor {
  key: string;
  type: ParsedDerivation['type'];
  expression: string;
  dependencies: Array<{
    key: string;
    value: unknown;
    runtimeNamespace?: string;
  }>;
  runtimeDependent: boolean;
  runtimeNamespaces: string[];
  promotionWarning?: string;
}

export interface DerivedRuntimeSupport {
  runtimeProviders: Map<string, RuntimeProvider>;
  read: (key: string, readBase: (key: string) => unknown) => unknown;
  describe: (key: string, readBase: (key: string) => unknown) => DerivedDescriptor | undefined;
  isDerivedKey: (key: string) => boolean;
  isRuntimeDependentKey: (key: string) => boolean;
  toConcreteValue: (
    key: string,
    readBase: (key: string) => unknown,
    mode: 'runtime' | 'env' | 'public' | 'server',
  ) => unknown;
  toServerFormula: (key: string) => DerivedFormula | undefined;
  derivedKeys: string[];
}

function namespaceForKey(key: string): string {
  return key.split('.')[0] ?? '';
}

function dependencyNamespaces(
  key: string,
  entries: Map<string, DerivedEntry>,
  memo: Map<string, string[]>,
): string[] {
  if (memo.has(key)) {
    return memo.get(key)!;
  }

  const entry = entries.get(key);

  if (!entry) {
    memo.set(key, []);
    return [];
  }

  const namespaces = new Set<string>();

  for (const ref of entry.parsed.refs) {
    const namespace = namespaceForKey(ref);

    if (!entries.has(ref)) {
      namespaces.add(namespace);
      continue;
    }

    for (const dependencyNamespace of dependencyNamespaces(ref, entries, memo)) {
      namespaces.add(dependencyNamespace);
    }
  }

  const result = Array.from(namespaces).sort((left, right) => left.localeCompare(right));
  memo.set(key, result);
  return result;
}

function isRuntimeDependentKey(
  key: string,
  entries: Map<string, DerivedEntry>,
  manifest: NormalizedManifest,
  memo: Map<string, boolean>,
): boolean {
  if (memo.has(key)) {
    return memo.get(key)!;
  }

  const entry = entries.get(key);

  if (!entry) {
    memo.set(key, false);
    return false;
  }

  for (const ref of entry.parsed.refs) {
    const namespace = namespaceForKey(ref);

    if (manifest.runtimeNamespaces[namespace]) {
      memo.set(key, true);
      return true;
    }

    if (entries.has(ref) && isRuntimeDependentKey(ref, entries, manifest, memo)) {
      memo.set(key, true);
      return true;
    }
  }

  memo.set(key, false);
  return false;
}

function prepareEntries(graph: ResolvedGraph, manifest: NormalizedManifest): Map<string, DerivedEntry> {
  const entries = new Map<string, DerivedEntry>();

  for (const [key, entry] of graph.entries) {
    if (!isDerivedValue(entry.value)) {
      continue;
    }

    const namespaceDefinition = manifest.namespaces[entry.namespace];

    if (!namespaceDefinition || namespaceDefinition.kind === 'data') {
      validateDerivedTargetNamespace(manifest, entry.namespace);
    }
    const parsed = parseDerivation(entry.value);
    validateParsedDerivation(manifest, parsed);

    entries.set(key, {
      key,
      namespace: entry.namespace,
      value: entry.value,
      parsed,
    });
  }

  detectDerivationCycles(
    new Map(
      Array.from(entries.values()).map((entry) => [
        entry.key,
        entry.parsed.refs.filter((ref) => entries.has(ref)),
      ]),
    ),
  );

  const runtimeMemo = new Map<string, boolean>();
  const namespaceMemo = new Map<string, string[]>();

  for (const entry of entries.values()) {
    entry.parsed.isRuntimeDependent = isRuntimeDependentKey(entry.key, entries, manifest, runtimeMemo);
    entry.parsed.runtimeRefs = entry.parsed.refs.filter((ref) => manifest.runtimeNamespaces[namespaceForKey(ref)]);
    if (entry.parsed.runtimeRefs.length === 0 && entry.parsed.isRuntimeDependent) {
      entry.parsed.runtimeRefs = dependencyNamespaces(entry.key, entries, namespaceMemo)
        .filter((namespace) => manifest.runtimeNamespaces[namespace])
        .map((namespace) => `${namespace}.*`);
    }
  }

  return entries;
}

export function createDerivedRuntimeSupport(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
  runtimeProviders: Map<string, RuntimeProvider>,
): DerivedRuntimeSupport {
  const entries = prepareEntries(graph, manifest);
  const configCache = new Map<string, unknown>();
  const runtimeDependencyMemo = new Map<string, boolean>();
  const support = {} as DerivedRuntimeSupport;

  Object.assign(support, {
    runtimeProviders,
    read(key, readBase) {
      const namespace = namespaceForKey(key);

      if (runtimeProviders.has(namespace)) {
        const provider = runtimeProviders.get(namespace)!;
        return provider(key.slice(namespace.length + 1));
      }

      if (entries.has(key)) {
        return readDerived(key, readBase);
      }

      return readBase(key);
    },
    describe(key, readBase) {
      const entry = entries.get(key);

      if (!entry) {
        return undefined;
      }

      const runtimeNamespaces = Array.from(
        new Set(
          entry.parsed.refs
            .map((ref) => namespaceForKey(ref))
            .filter((namespace) => manifest.runtimeNamespaces[namespace]),
        ),
      ).sort((left, right) => left.localeCompare(right));

      return {
        key,
        type: entry.parsed.type,
        expression: entry.parsed.raw,
        dependencies: entry.parsed.refs.map((ref) => {
          const namespace = namespaceForKey(ref);
          return {
            key: ref,
            value: support.read(ref, readBase),
            ...(manifest.runtimeNamespaces[namespace]
              ? {
                  runtimeNamespace: namespace,
                }
              : {}),
          };
        }),
        runtimeDependent: entry.parsed.isRuntimeDependent,
        runtimeNamespaces,
        ...(entry.parsed.isRuntimeDependent
          ? {
              promotionWarning: 'Cannot be promoted to browser/public.',
            }
          : {}),
      };
    },
    isDerivedKey(key) {
      return entries.has(key);
    },
    isRuntimeDependentKey(key) {
      if (runtimeDependencyMemo.has(key)) {
        return runtimeDependencyMemo.get(key)!;
      }

      const value = entries.get(key)?.parsed.isRuntimeDependent ?? false;
      runtimeDependencyMemo.set(key, value);
      return value;
    },
    toConcreteValue(key, readBase, mode) {
      const entry = entries.get(key);

      if (!entry) {
        return support.read(key, readBase);
      }

      if (!entry.parsed.isRuntimeDependent) {
        return support.read(key, readBase);
      }

      if (mode === 'server' || mode === 'runtime') {
        return support.read(key, readBase);
      }

      for (const ref of entry.parsed.refs) {
        const namespace = namespaceForKey(ref);
        const runtimeNamespace = manifest.runtimeNamespaces[namespace];

        if (!runtimeNamespace) {
          continue;
        }

        if (runtimeNamespace.serverOnly) {
          throw new CnosDerivedResolutionError(
            key,
            `Cannot resolve ${key} for ${mode} output because it depends on runtime namespace ${namespace}.`,
          );
        }

        if (!runtimeProviders.has(namespace)) {
          if (mode === 'env') {
            return undefined;
          }

          throw new CnosDerivedResolutionError(
            key,
            `Cannot resolve ${key} for ${mode} output because runtime namespace ${namespace} has no registered provider.`,
          );
        }
      }

      return support.read(key, readBase);
    },
    toServerFormula(key) {
      const entry = entries.get(key);

      if (!entry || !entry.parsed.isRuntimeDependent) {
        return undefined;
      }

      return {
        expr: entry.parsed.raw,
        deps: entry.parsed.refs.filter((ref) => !manifest.runtimeNamespaces[namespaceForKey(ref)]),
        runtimeRefs: entry.parsed.refs.filter((ref) => manifest.runtimeNamespaces[namespaceForKey(ref)]),
      };
    },
    derivedKeys: Array.from(entries.keys()).sort((left, right) => left.localeCompare(right)),
  } satisfies DerivedRuntimeSupport);

  const readDerived = (
    key: string,
    readBase: (key: string) => unknown,
    evaluationStack = new Set<string>(),
  ): unknown => {
    const entry = entries.get(key);

    if (!entry) {
      return readBase(key);
    }

    if (!entry.parsed.isRuntimeDependent && configCache.has(key)) {
      return configCache.get(key);
    }

    const value = evaluateDerivation({
      key,
      parsed: entry.parsed,
      resolveRef: (ref) => {
        const namespace = namespaceForKey(ref);

        if (runtimeProviders.has(namespace)) {
          const provider = runtimeProviders.get(namespace)!;
          return provider(ref.slice(namespace.length + 1));
        }

        if (entries.has(ref)) {
          if (evaluationStack.has(ref)) {
            throw new CnosDerivedResolutionError(key, `Unable to resolve derived config key ${key} because of a recursive dependency on ${ref}.`);
          }

          evaluationStack.add(ref);
          const resolved = readDerived(ref, readBase, evaluationStack);
          evaluationStack.delete(ref);
          return resolved;
        }

        return readBase(ref);
      },
    });

    if (!entry.parsed.isRuntimeDependent) {
      configCache.set(key, value);
    }

    return value;
  };

  for (const key of Array.from(entries.keys()).sort((left, right) => left.localeCompare(right))) {
    const entry = entries.get(key)!;

    if (!entry.parsed.isRuntimeDependent) {
      readDerived(key, (ref) => graph.entries.get(ref)?.value);
    }
  }

  return support;
}

export function registerRuntimeProvider(
  manifest: NormalizedManifest,
  runtimeProviders: Map<string, RuntimeProvider>,
  namespace: string,
  provider: RuntimeProvider,
): void {
  const definition = manifest.runtimeNamespaces[namespace];

  if (!definition) {
    throw new CnosRuntimeProviderError(`Cannot register runtime provider for undeclared namespace "${namespace}".`);
  }

  if (definition.builtIn) {
    throw new CnosRuntimeProviderError(`Cannot override built-in runtime namespace "${namespace}".`);
  }

  runtimeProviders.set(namespace, provider);
}
