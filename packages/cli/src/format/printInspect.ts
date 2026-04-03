import type { InspectResult } from '@kitsy/cnos';

export function printInspect(record: InspectResult): string {
  const lines = [
    `key: ${record.key}`,
    `value: ${String(record.value)}`,
    `namespace: ${record.namespace}`,
    `profile: ${record.profile} (${record.profileSource})`,
    `workspace: ${record.workspace.id} (${record.workspace.source})`,
    `workspaceChain: ${record.workspace.chain.join(' -> ')}`,
    `winner: ${record.winner.sourceId} via ${record.winner.pluginId} @ ${record.winner.workspaceId}`,
  ];

  if (record.winner.origin?.file) {
    lines.push(`winnerOrigin: ${record.winner.origin.file}`);
  }

  if (record.overridden.length > 0) {
    lines.push(
      `overridden: ${record.overridden
        .map((entry) => `${entry.sourceId}@${entry.workspaceId}=${String(entry.value)}`)
        .join(', ')}`,
    );
  }

  return lines.join('\n');
}
