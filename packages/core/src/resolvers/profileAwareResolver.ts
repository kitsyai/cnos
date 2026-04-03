import type { ResolvedEntry, ResolvedGraph } from '../types/core.js';
import type { ResolverPlugin } from '../types/plugin.js';
import { deepMerge, isPlainObject } from '../utils/deepMerge.js';

function mergeResolvedValue(
  currentValue: unknown,
  nextValue: unknown,
  arrayPolicy: 'replace' | 'append' | 'unique-append',
): unknown {
  if (Array.isArray(currentValue) && Array.isArray(nextValue)) {
    if (arrayPolicy === 'append') {
      return [...currentValue, ...nextValue];
    }

    if (arrayPolicy === 'unique-append') {
      return [...new Set([...currentValue, ...nextValue])];
    }

    return [...nextValue];
  }

  if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
    return deepMerge(currentValue, nextValue);
  }

  return nextValue;
}

export function createProfileAwareResolver(): ResolverPlugin {
  return {
    id: 'profile-aware',
    kind: 'resolver',
    async resolve(entries, context): Promise<ResolvedGraph> {
      const precedence = new Map(context.precedenceOrder.map((sourceId, index) => [sourceId, index]));
      const sortedEntries = entries
        .map((entry, index) => ({
          entry,
          index,
          precedence: precedence.get(entry.sourceId) ?? context.precedenceOrder.length,
        }))
        .sort((left, right) => left.precedence - right.precedence || left.index - right.index);

      const resolvedEntries = new Map<string, ResolvedEntry>();

      for (const { entry } of sortedEntries) {
        const current = resolvedEntries.get(entry.key);

        if (!current) {
          resolvedEntries.set(entry.key, {
            key: entry.key,
            value: entry.value,
            namespace: entry.namespace,
            winner: entry,
            overridden: [],
          });
          continue;
        }

        resolvedEntries.set(entry.key, {
          key: entry.key,
          value: mergeResolvedValue(current.value, entry.value, context.manifest.resolution.arrayPolicy),
          namespace: current.namespace,
          winner: entry,
          overridden: [...current.overridden, current.winner],
        });
      }

      return {
        entries: resolvedEntries,
        profile: context.profile,
        resolvedAt: new Date().toISOString(),
        profileSource: 'manifest-default',
        workspace: context.workspace,
      };
    },
  };
}
