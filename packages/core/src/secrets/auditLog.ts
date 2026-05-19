import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveSecretStoreRoot } from '../utils/secretStore.js';

export interface AuditEvent {
  action: string;
  vault: string;
  caller: 'runtime' | 'cli';
  refs?: string[];
  ref?: string;
  method?: string;
  workspace?: string;
  profile?: string;
  reason?: string;
}

export async function appendAuditEvent(
  event: AuditEvent,
  processEnv: Record<string, string | undefined> = process.env,
): Promise<void> {
  const auditFile = processEnv.CNOS_AUDIT_FILE ?? path.join(resolveSecretStoreRoot(processEnv), 'audit', 'access.log');

  try {
    await mkdir(path.dirname(auditFile), { recursive: true });
    await appendFile(
      auditFile,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...event,
      })}\n`,
      'utf8',
    );
  } catch {
    // Audit writes must not block runtime secret resolution paths.
  }
}
