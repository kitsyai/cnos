import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expandHomePath } from '../utils/path.js';

interface VaultSessionDocument {
  version: 1;
  vault: string;
  derivedKey: string;
  createdAt: string;
}

function buildSessionRoot(processEnv: Record<string, string | undefined> = process.env): string {
  return path.join(path.resolve(expandHomePath(processEnv.CNOS_SECRET_HOME ?? '~/.cnos/secrets')), 'sessions');
}

function buildSessionPath(vault: string, processEnv?: Record<string, string | undefined>): string {
  return path.join(buildSessionRoot(processEnv), `${vault}.json`);
}

export async function writeVaultSessionKey(
  vault: string,
  derivedKey: Buffer,
  processEnv?: Record<string, string | undefined>,
): Promise<string> {
  const filePath = buildSessionPath(vault, processEnv);
  await mkdir(path.dirname(filePath), { recursive: true });
  const document: VaultSessionDocument = {
    version: 1,
    vault,
    derivedKey: derivedKey.toString('hex'),
    createdAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(document, null, 2), 'utf8');
  return filePath;
}

export async function readVaultSessionKey(
  vault: string,
  processEnv?: Record<string, string | undefined>,
): Promise<Buffer | undefined> {
  try {
    const source = await readFile(buildSessionPath(vault, processEnv), 'utf8');
    const document = JSON.parse(source) as Partial<VaultSessionDocument>;

    if (document.version !== 1 || typeof document.derivedKey !== 'string') {
      return undefined;
    }

    const key = Buffer.from(document.derivedKey, 'hex');
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

export async function clearVaultSessionKey(
  vault: string,
  processEnv?: Record<string, string | undefined>,
): Promise<void> {
  await rm(buildSessionPath(vault, processEnv), { force: true });
}

export async function clearAllVaultSessionKeys(processEnv?: Record<string, string | undefined>): Promise<void> {
  const root = buildSessionRoot(processEnv);

  try {
    const entries = await readdir(root);
    await Promise.all(entries.map((entry) => rm(path.join(root, entry), { force: true })));
  } catch {
    // ignore
  }
}
