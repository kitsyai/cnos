import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CnosAuthenticationError, CnosManifestError, CnosSecurityError } from '../errors.js';
import type { VaultDefinition } from '../types/manifest.js';
import type { SecretReference, VaultAuthConfig } from '../secrets/types.js';
import { readVaultSessionKey } from '../secrets/sessionStore.js';
import { expandHomePath } from './path.js';
import { parseYaml, stringifyYaml } from './yaml.js';

const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 600000;
const KEYSTORE_VERSION = 1;
const METADATA_VERSION = 1;
const META_FILENAME = 'meta.yml';
const KEYSTORE_FILENAME = 'keystore.enc';

export interface ResolvedVaultDefinition extends VaultDefinition {
  name: string;
  requiresAuthentication: boolean;
}

export interface VaultMetadata {
  version: 1;
  algorithm: 'aes-256-gcm';
  kdf: 'pbkdf2-sha512';
  iterations: number;
  salt: string;
  createdAt: string;
  secretCount: number;
}

interface VaultPayload {
  secrets: Record<string, string>;
  metadata: Record<string, { createdAt: string; updatedAt: string }>;
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

function normalizeVaultToken(vault = 'default'): string {
  return vault
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function getVaultPassphraseEnvVar(vault = 'default'): string {
  const vaultToken = normalizeVaultToken(vault);
  return vaultToken && vaultToken !== 'DEFAULT' ? `CNOS_SECRET_PASSPHRASE_${vaultToken}` : 'CNOS_SECRET_PASSPHRASE';
}

export function isPassphraseEnvRef(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('env:') && value.length > 4;
}

export function getVaultSessionKeyEnvVar(vault = 'default'): string {
  const vaultToken = normalizeVaultToken(vault);
  return `__CNOS_VAULT_KEY_${vaultToken || 'DEFAULT'}__`;
}

export function resolveSecretPassphrase(
  vault = 'default',
  processEnv: Record<string, string | undefined> = process.env,
): string | undefined {
  return processEnv[getVaultPassphraseEnvVar(vault)] ?? processEnv.CNOS_SECRET_PASSPHRASE;
}

export function resolveVaultSessionKey(
  vault = 'default',
  processEnv: Record<string, string | undefined> = process.env,
): Promise<Buffer | undefined> | Buffer | undefined {
  const encoded = processEnv[getVaultSessionKeyEnvVar(vault)];

  if (!encoded) {
    return readVaultSessionKey(vault, processEnv);
  }

  try {
    const key = Buffer.from(encoded, 'hex');
    return key.length === KEY_LENGTH ? key : undefined;
  } catch {
    return undefined;
  }
}

export function deriveVaultKey(passphrase: string, salt: Buffer, iterations = PBKDF2_ITERATIONS): Buffer {
  return pbkdf2Sync(passphrase, salt, iterations, KEY_LENGTH, 'sha512');
}

function buildMetaPath(storeRoot: string, vault = 'default'): string {
  return path.join(storeRoot, 'vaults', vault, META_FILENAME);
}

export function resolveSecretVaultFile(storeRoot: string, vault = 'default'): string {
  return buildMetaPath(storeRoot, vault);
}

function buildKeystorePath(storeRoot: string, vault = 'default'): string {
  return path.join(storeRoot, 'vaults', vault, KEYSTORE_FILENAME);
}

function buildLegacyVaultFile(storeRoot: string, vault = 'default'): string {
  return path.join(storeRoot, 'vaults', `${vault}.json`);
}

function buildLegacyVaultStoreRoot(storeRoot: string, vault = 'default'): string {
  return path.join(storeRoot, 'vaults', vault, 'store');
}

function assertVaultMetadata(value: unknown, filePath: string): VaultMetadata {
  if (!isObject(value)) {
    throw new CnosManifestError('Invalid CNOS vault metadata', filePath);
  }

  if (
    value.version !== METADATA_VERSION ||
    value.algorithm !== 'aes-256-gcm' ||
    value.kdf !== 'pbkdf2-sha512' ||
    typeof value.iterations !== 'number' ||
    typeof value.salt !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.secretCount !== 'number'
  ) {
    throw new CnosManifestError('Invalid CNOS vault metadata', filePath);
  }

  return value as unknown as VaultMetadata;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function detectLegacyVaultFormat(storeRoot: string, vault = 'default'): Promise<string | undefined> {
  const legacyFile = buildLegacyVaultFile(storeRoot, vault);
  const legacyStore = buildLegacyVaultStoreRoot(storeRoot, vault);

  if (await exists(legacyFile)) {
    return legacyFile;
  }

  if (await exists(legacyStore)) {
    return legacyStore;
  }

  return undefined;
}

export async function assertNoLegacyVaultFormat(storeRoot: string, vault = 'default'): Promise<void> {
  const legacyPath = await detectLegacyVaultFormat(storeRoot, vault);

  if (!legacyPath) {
    return;
  }

  throw new CnosSecurityError(
    `Legacy CNOS local vault format detected for vault "${vault}" at ${legacyPath}. CNOS 1.4 requires the new keystore format. Remove and recreate the vault.`,
  );
}

function encryptPayload(payload: VaultPayload, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from(Uint32Array.of(KEYSTORE_VERSION).buffer),
    iv,
    tag,
    ciphertext,
  ]);
}

function decryptPayload(buffer: Buffer, key: Buffer): VaultPayload {
  if (buffer.length < 4 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new CnosSecurityError('Invalid CNOS local vault keystore');
  }

  const version = buffer.readUInt32LE(0);

  if (version !== KEYSTORE_VERSION) {
    throw new CnosSecurityError(`Unsupported CNOS local vault keystore version: ${version}`);
  }

  const ivOffset = 4;
  const tagOffset = ivOffset + IV_LENGTH;
  const cipherOffset = tagOffset + AUTH_TAG_LENGTH;
  const iv = buffer.subarray(ivOffset, tagOffset);
  const tag = buffer.subarray(tagOffset, cipherOffset);
  const ciphertext = buffer.subarray(cipherOffset);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plaintext) as Partial<VaultPayload>;

    if (
      !payload ||
      !isObject(payload.secrets) ||
      !isObject(payload.metadata)
    ) {
      throw new Error('invalid');
    }

    return {
      secrets: Object.fromEntries(
        Object.entries(payload.secrets).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
      metadata: Object.fromEntries(
        Object.entries(payload.metadata).filter(
          (entry): entry is [string, { createdAt: string; updatedAt: string }] =>
            isObject(entry[1]) &&
            typeof entry[1].createdAt === 'string' &&
            typeof entry[1].updatedAt === 'string',
        ),
      ),
    };
  } catch {
    throw new CnosAuthenticationError('Failed to decrypt CNOS local vault. Check vault authentication.');
  }
}

function buildInitialPayload(): VaultPayload {
  return {
    secrets: {},
    metadata: {},
  };
}

async function writeVaultFiles(storeRoot: string, vault: string, meta: VaultMetadata, payload: VaultPayload, key: Buffer): Promise<void> {
  const metaPath = buildMetaPath(storeRoot, vault);
  const keystorePath = buildKeystorePath(storeRoot, vault);
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, stringifyYaml(meta), 'utf8');
  await writeFile(keystorePath, encryptPayload(payload, key));
}

export async function readVaultMetadata(storeRoot: string, vault = 'default'): Promise<VaultMetadata | undefined> {
  await assertNoLegacyVaultFormat(storeRoot, vault);
  const metaPath = buildMetaPath(storeRoot, vault);

  try {
    const source = await readFile(metaPath, 'utf8');
    return assertVaultMetadata(parseYaml<unknown>(source), metaPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

export async function listSecretVaults(storeRoot: string): Promise<string[]> {
  const vaultRoot = path.join(storeRoot, 'vaults');

  try {
    const entries = await readdir(vaultRoot, { withFileTypes: true });
    const vaults = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => ((await exists(path.join(vaultRoot, entry.name, META_FILENAME))) ? entry.name : undefined)),
    );
    return vaults.filter((value): value is string => Boolean(value)).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function createSecretVault(
  storeRoot: string,
  vault: string,
  passphrase: string,
): Promise<string> {
  const normalizedVault = vault.trim() || 'default';
  await assertNoLegacyVaultFormat(storeRoot, normalizedVault);
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS);
  const createdAt = new Date().toISOString();
  const meta: VaultMetadata = {
    version: METADATA_VERSION,
    algorithm: 'aes-256-gcm',
    kdf: 'pbkdf2-sha512',
    iterations: PBKDF2_ITERATIONS,
    salt: salt.toString('base64'),
    createdAt,
    secretCount: 0,
  };

  await writeVaultFiles(storeRoot, normalizedVault, meta, buildInitialPayload(), key);
  return buildMetaPath(storeRoot, normalizedVault);
}

export async function ensureSecretVault(
  storeRoot: string,
  vault: string,
  passphrase: string,
): Promise<string> {
  const normalizedVault = vault.trim() || 'default';
  const meta = await readVaultMetadata(storeRoot, normalizedVault);

  if (meta) {
    return buildMetaPath(storeRoot, normalizedVault);
  }

  return createSecretVault(storeRoot, normalizedVault, passphrase);
}

export function resolveConfiguredVaultPassphrase(
  definition: VaultDefinition | undefined,
  vault = 'default',
  processEnv: Record<string, string | undefined> = process.env,
): string | undefined {
  if (definition?.provider !== 'local') {
    return undefined;
  }

  const configuredSources = definition.auth?.passphrase?.from ?? [];

  for (const source of configuredSources) {
    if (source.startsWith('env:')) {
      const value = processEnv[source.slice(4)];

      if (value) {
        return value;
      }
    }
  }

  return resolveSecretPassphrase(vault, processEnv);
}

export async function resolveVaultAccessKey(
  storeRoot: string,
  definition: VaultDefinition | undefined,
  vault = 'default',
  processEnv: Record<string, string | undefined> = process.env,
): Promise<VaultAuthConfig | undefined> {
  if (definition?.provider !== 'local') {
    return definition?.provider === 'github-secrets'
      ? {
          method: definition.auth?.method ?? 'environment',
          ...(definition?.auth?.config ? { config: definition.auth.config } : {}),
        }
      : undefined;
  }

  const sessionKey = await resolveVaultSessionKey(vault, processEnv);

  if (sessionKey) {
    return {
      derivedKey: sessionKey,
      method: 'keychain',
      ...(definition.auth?.config ? { config: definition.auth.config } : {}),
    };
  }

  const passphrase = resolveConfiguredVaultPassphrase(definition, vault, processEnv);

  if (passphrase) {
    return {
      passphrase,
      method: 'passphrase',
      ...(definition.auth?.config ? { config: definition.auth.config } : {}),
    };
  }

  const metadata = await readVaultMetadata(storeRoot, vault);

  if (!metadata) {
    return undefined;
  }

  throw new CnosAuthenticationError(
    `Cannot authenticate to vault "${vault}". Set ${getVaultPassphraseEnvVar(vault)} or run cnos vault auth ${vault}.`,
  );
}

async function loadVaultPayload(
  storeRoot: string,
  vault: string,
  auth: VaultAuthConfig,
): Promise<{ meta: VaultMetadata; payload: VaultPayload; key: Buffer }> {
  const meta = await readVaultMetadata(storeRoot, vault);

  if (!meta) {
    throw new CnosManifestError(`Missing CNOS vault metadata for "${vault}"`);
  }

  const salt = Buffer.from(meta.salt, 'base64');
  const key = auth.derivedKey ?? (auth.passphrase ? deriveVaultKey(auth.passphrase, salt, meta.iterations) : undefined);

  if (!key) {
    throw new CnosAuthenticationError(`Vault "${vault}" requires authentication before access.`);
  }

  const buffer = await readFile(buildKeystorePath(storeRoot, vault));
  return {
    meta,
    payload: decryptPayload(buffer, key),
    key,
  };
}

export async function writeLocalSecret(
  storeRoot: string,
  ref: string,
  value: string,
  authOrPassphrase: VaultAuthConfig | string,
  vault = 'default',
): Promise<string> {
  const auth =
    typeof authOrPassphrase === 'string'
      ? ({
          passphrase: authOrPassphrase,
          method: 'passphrase',
        } satisfies VaultAuthConfig)
      : authOrPassphrase;

  if (auth.passphrase) {
    await ensureSecretVault(storeRoot, vault, auth.passphrase);
  } else {
    const meta = await readVaultMetadata(storeRoot, vault);

    if (!meta) {
      throw new CnosAuthenticationError(`Vault "${vault}" requires passphrase-based authentication for initial creation.`);
    }
  }

  const { meta, payload, key } = await loadVaultPayload(storeRoot, vault, auth);
  const now = new Date().toISOString();
  const existing = payload.metadata[ref];

  payload.secrets[ref] = value;
  payload.metadata[ref] = {
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const nextMeta: VaultMetadata = {
    ...meta,
    secretCount: Object.keys(payload.secrets).length,
  };

  await writeVaultFiles(storeRoot, vault, nextMeta, payload, key);
  return buildKeystorePath(storeRoot, vault);
}

export async function deleteLocalSecret(
  storeRoot: string,
  ref: string,
  auth: VaultAuthConfig,
  vault = 'default',
): Promise<boolean> {
  const { meta, payload, key } = await loadVaultPayload(storeRoot, vault, auth);

  if (!(ref in payload.secrets)) {
    return false;
  }

  delete payload.secrets[ref];
  delete payload.metadata[ref];
  const nextMeta: VaultMetadata = {
    ...meta,
    secretCount: Object.keys(payload.secrets).length,
  };
  await writeVaultFiles(storeRoot, vault, nextMeta, payload, key);
  return true;
}

export async function readLocalSecret(
  storeRoot: string,
  ref: string,
  auth: VaultAuthConfig,
  vault = 'default',
): Promise<string> {
  const { payload } = await loadVaultPayload(storeRoot, vault, auth);
  const value = payload.secrets[ref];

  if (value === undefined) {
    throw new CnosManifestError(`Missing local secret ref "${ref}" in vault "${vault}"`);
  }

  return value;
}

export async function listLocalSecrets(
  storeRoot: string,
  auth: VaultAuthConfig,
  vault = 'default',
): Promise<string[]> {
  const { payload } = await loadVaultPayload(storeRoot, vault, auth);
  return Object.keys(payload.secrets).sort((left, right) => left.localeCompare(right));
}

export function resolveVaultDefinition(
  vaults: Record<string, VaultDefinition> | undefined,
  vault = 'default',
): ResolvedVaultDefinition {
  const definition = vaults?.[vault];
  const provider = definition?.provider ?? 'local';

  return {
    name: vault,
    provider,
    ...(definition?.auth ? { auth: definition.auth } : {}),
    ...(definition?.mapping ? { mapping: definition.mapping } : {}),
    requiresAuthentication: provider === 'local',
  };
}

export async function removeLocalVaultFiles(storeRoot: string, vault = 'default'): Promise<void> {
  await rm(path.join(storeRoot, 'vaults', vault), { recursive: true, force: true });
}
