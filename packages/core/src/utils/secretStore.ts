import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import { expandHomePath } from './path.js';

export interface SecretReference {
  provider: string;
  ref: string;
  vault?: string;
}

interface EncryptedSecretDocument {
  version: 1;
  algorithm: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface VaultDocument {
  version: 1;
  name: string;
  createdAt: string;
  verifier: EncryptedSecretDocument;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSecretReference(value: unknown): value is SecretReference {
  return (
    isObject(value) &&
    typeof value.provider === 'string' &&
    value.provider.trim().length > 0 &&
    typeof value.ref === 'string' &&
    value.ref.trim().length > 0 &&
    ((value.vault === undefined && true) || (typeof value.vault === 'string' && value.vault.trim().length > 0)) &&
    Object.keys(value).every((key) => ['provider', 'ref', 'vault'].includes(key))
  );
}

export function resolveSecretStoreRoot(processEnv: Record<string, string | undefined> = process.env): string {
  return path.resolve(expandHomePath(processEnv.CNOS_SECRET_HOME ?? '~/.cnos/secrets'));
}

export function resolveSecretVaultFile(storeRoot: string, vault = 'default'): string {
  return path.join(storeRoot, 'vaults', `${vault}.json`);
}

export function resolveSecretStoreFile(storeRoot: string, ref: string, vault = 'default'): string {
  return path.join(storeRoot, 'vaults', vault, 'store', ...ref.split('/')).concat('.json');
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

export function resolveSecretPassphrase(
  vault = 'default',
  processEnv: Record<string, string | undefined> = process.env,
): string | undefined {
  const vaultToken = vault
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return processEnv[`CNOS_SECRET_PASSPHRASE_${vaultToken}`] ?? processEnv.CNOS_SECRET_PASSPHRASE;
}

function encryptDocument(value: string, passphrase: string): EncryptedSecretDocument {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptDocument(document: EncryptedSecretDocument, passphrase: string): string {
  const salt = Buffer.from(document.salt, 'base64');
  const iv = Buffer.from(document.iv, 'base64');
  const tag = Buffer.from(document.tag, 'base64');
  const ciphertext = Buffer.from(document.ciphertext, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export async function createSecretVault(
  storeRoot: string,
  vault: string,
  passphrase: string,
): Promise<string> {
  const normalizedVault = vault.trim() || 'default';
  const filePath = resolveSecretVaultFile(storeRoot, normalizedVault);
  await mkdir(path.dirname(filePath), { recursive: true });
  const document: VaultDocument = {
    version: 1,
    name: normalizedVault,
    createdAt: new Date().toISOString(),
    verifier: encryptDocument(`cnos-vault:${normalizedVault}`, passphrase),
  };
  await writeFile(filePath, JSON.stringify(document, null, 2), 'utf8');
  return filePath;
}

export async function ensureSecretVault(
  storeRoot: string,
  vault: string,
  passphrase: string,
): Promise<string> {
  const normalizedVault = vault.trim() || 'default';
  const filePath = resolveSecretVaultFile(storeRoot, normalizedVault);

  try {
    await readFile(filePath, 'utf8');
    return filePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return createSecretVault(storeRoot, normalizedVault, passphrase);
}

export async function listSecretVaults(storeRoot: string): Promise<string[]> {
  const vaultRoot = path.join(storeRoot, 'vaults');

  try {
    const entries = await readdir(vaultRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function writeLocalSecret(
  storeRoot: string,
  ref: string,
  value: string,
  passphrase: string,
  vault = 'default',
): Promise<string> {
  await ensureSecretVault(storeRoot, vault, passphrase);
  const filePath = resolveSecretStoreFile(storeRoot, ref, vault);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(encryptDocument(value, passphrase), null, 2), 'utf8');
  return filePath;
}

export async function readLocalSecret(
  storeRoot: string,
  ref: string,
  passphrase?: string,
  vault = 'default',
): Promise<string> {
  if (!passphrase) {
    throw new CnosManifestError(
      `Missing CNOS secret passphrase for local secret ref "${ref}". Set CNOS_SECRET_PASSPHRASE or pass processEnv explicitly.`,
    );
  }

  const filePath = resolveSecretStoreFile(storeRoot, ref, vault);
  const source = await readFile(filePath, 'utf8');
  const document = JSON.parse(source) as Partial<EncryptedSecretDocument>;

  if (
    document.version !== 1 ||
    document.algorithm !== 'aes-256-gcm' ||
    typeof document.salt !== 'string' ||
    typeof document.iv !== 'string' ||
    typeof document.tag !== 'string' ||
    typeof document.ciphertext !== 'string'
  ) {
    throw new CnosManifestError('Invalid local secret document', filePath);
  }

  return decryptDocument(document as EncryptedSecretDocument, passphrase);
}
