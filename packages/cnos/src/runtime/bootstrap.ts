import type { ConfigEntry, ResolvedEntry, ResolvedGraph } from '@kitsy/cnos-core';

export const CNOS_GRAPH_ENV_VAR = '__CNOS_GRAPH__';

interface SerializedResolvedEntry extends Omit<ResolvedEntry, 'winner' | 'overridden'> {
  winner: ConfigEntry;
  overridden: ConfigEntry[];
}

interface SerializedRuntimeGraph {
  entries: SerializedResolvedEntry[];
  profile: string;
  resolvedAt: string;
  profileSource: ResolvedGraph['profileSource'];
  workspace: ResolvedGraph['workspace'];
}

export function serializeRuntimeGraph(graph: ResolvedGraph): string {
  const payload: SerializedRuntimeGraph = {
    entries: Array.from(graph.entries.values()),
    profile: graph.profile,
    resolvedAt: graph.resolvedAt,
    profileSource: graph.profileSource,
    workspace: graph.workspace,
  };

  return JSON.stringify(payload);
}

export function deserializeRuntimeGraph(source: string): ResolvedGraph {
  const payload = JSON.parse(source) as Partial<SerializedRuntimeGraph>;

  if (
    !payload ||
    !Array.isArray(payload.entries) ||
    typeof payload.profile !== 'string' ||
    typeof payload.resolvedAt !== 'string' ||
    !payload.profileSource ||
    !payload.workspace ||
    typeof payload.workspace.workspaceId !== 'string' ||
    !Array.isArray(payload.workspace.workspaceChain) ||
    !Array.isArray(payload.workspace.workspaceRoots)
  ) {
    throw new Error('Invalid CNOS runtime bootstrap payload');
  }

  return {
    entries: new Map(
      payload.entries.map((entry) => [
        entry.key,
        {
          key: entry.key,
          value: entry.value,
          namespace: entry.namespace,
          winner: entry.winner,
          overridden: entry.overridden ?? [],
        } satisfies ResolvedEntry,
      ]),
    ),
    profile: payload.profile,
    resolvedAt: payload.resolvedAt,
    profileSource: payload.profileSource,
    workspace: payload.workspace,
  };
}

export function readRuntimeGraphFromEnv(
  processEnv: Record<string, string | undefined> = process.env,
): ResolvedGraph | undefined {
  const serialized = processEnv[CNOS_GRAPH_ENV_VAR];

  if (!serialized) {
    return undefined;
  }

  return deserializeRuntimeGraph(serialized);
}
