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

  if (record.derived) {
    lines.push(`derivedType: ${record.derived.type}`);
    lines.push(`derivedExpression: ${record.derived.expression}`);
    lines.push(`runtimeDependent: ${record.derived.runtimeDependent ? 'yes' : 'no'}`);

    if (record.derived.runtimeNamespaces.length > 0) {
      lines.push(`runtimeNamespaces: ${record.derived.runtimeNamespaces.join(', ')}`);
    }

    if (record.derived.dependencies.length > 0) {
      lines.push(
        `dependencies: ${record.derived.dependencies
          .map((entry) => `${entry.key}=${String(entry.value)}${entry.runtimeNamespace ? ` (${entry.runtimeNamespace})` : ''}`)
          .join(', ')}`,
      );
    }

    if (record.derived.promotionWarning) {
      lines.push(`warning: ${record.derived.promotionWarning}`);
    }
  }

  return lines.join('\n');
}
