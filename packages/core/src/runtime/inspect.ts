import { CnosKeyNotFoundError } from '../errors.js';
import type { InspectResult, LogicalKey, ResolvedGraph } from '../types/core.js';

export function inspectValue(
  graph: ResolvedGraph,
  key: LogicalKey,
  helpers: {
    read?: (key: string) => unknown;
    describeDerived?: (key: string) => InspectResult['derived'] | undefined;
  } = {},
): InspectResult {
  const entry = graph.entries.get(key);

  if (!entry) {
    throw new CnosKeyNotFoundError(key);
  }

  const derived = helpers.describeDerived?.(key);

  return {
    key: entry.key,
    value: helpers.read ? helpers.read(entry.key) : entry.value,
    namespace: entry.namespace,
    profile: graph.profile,
    profileSource: graph.profileSource,
    workspace: {
      id: graph.workspace.workspaceId,
      source: graph.workspace.workspaceSource,
      chain: graph.workspace.workspaceChain,
    },
    winner: {
      sourceId: entry.winner.sourceId,
      pluginId: entry.winner.pluginId,
      workspaceId: entry.winner.workspaceId,
      ...(entry.winner.origin ? { origin: entry.winner.origin } : {}),
    },
    overridden: entry.overridden.map((override) => ({
      sourceId: override.sourceId,
      pluginId: override.pluginId,
      workspaceId: override.workspaceId,
      value: override.value,
      ...(override.origin ? { origin: override.origin } : {}),
    })),
    ...(derived
      ? {
          derived,
        }
      : {}),
  };
}
