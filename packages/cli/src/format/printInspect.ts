import type { InspectResult } from '@kitsy/cnos';

export function printInspect(record: InspectResult): string {
  return `${record.key}=${String(record.value)} via ${record.winner.sourceId}`;
}
