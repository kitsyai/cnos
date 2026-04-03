import type { CnosInspectRecord } from '@kitsy/cnos';

export function printInspect(records: CnosInspectRecord[]): string {
  return records
    .map((record) => `${record.key}=${String(record.value)} (${record.resolved ? 'resolved' : 'missing'})`)
    .join('\n');
}
