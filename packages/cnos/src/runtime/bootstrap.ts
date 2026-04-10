import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { ConfigEntry, ResolvedEntry, ResolvedGraph, ServerProjection } from '@kitsy/cnos-core';
import { isSecretReference } from '@kitsy/cnos-core';

export const CNOS_GRAPH_ENV_VAR = '__CNOS_GRAPH__';
export const CNOS_PROJECTION_ENV_VAR = '__CNOS_PROJECTION__';
export const CNOS_SECRET_PAYLOAD_ENV_VAR = '__CNOS_SECRET_PAYLOAD__';
export const CNOS_SESSION_KEY_ENV_VAR = '__CNOS_SESSION_KEY__';

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

interface SerializedSecretPayload {
  iv: string;
  tag: string;
  ciphertext: string;
}

export function serializeServerProjection(projection: ServerProjection): string {
  return JSON.stringify(projection);
}

export function deserializeServerProjection(source: string): ServerProjection {
  const payload = JSON.parse(source) as Partial<ServerProjection>;

  if (
    !payload ||
    payload.version !== 1 ||
    typeof payload.workspace !== 'string' ||
    typeof payload.profile !== 'string' ||
    typeof payload.resolvedAt !== 'string' ||
    typeof payload.configHash !== 'string' ||
    !payload.values ||
    typeof payload.values !== 'object' ||
    Array.isArray(payload.values) ||
    !payload.secretRefs ||
    typeof payload.secretRefs !== 'object' ||
    Array.isArray(payload.secretRefs) ||
    !Array.isArray(payload.publicKeys) ||
    !payload.meta ||
    typeof payload.meta !== 'object'
  ) {
    throw new Error('Invalid CNOS server projection payload');
  }

  return payload as ServerProjection;
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

function decryptSecretPayload(
  serialized: string,
  sessionKey: string,
): Record<string, unknown> {
  const payload = JSON.parse(serialized) as Partial<SerializedSecretPayload>;

  if (
    !payload ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.ciphertext !== 'string'
  ) {
    throw new Error('Invalid CNOS secret payload');
  }

  const key = Buffer.from(sessionKey, 'hex');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as Record<string, unknown>;
}

export function serializeSecretPayload(values: Record<string, unknown>): { payload: string; sessionKey: string } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    payload: JSON.stringify({
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    } satisfies SerializedSecretPayload),
    sessionKey: key.toString('hex'),
  };
}

export function readRuntimeGraphFromEnv(
  processEnv: Record<string, string | undefined> = process.env,
): ResolvedGraph | undefined {
  const serialized = processEnv[CNOS_GRAPH_ENV_VAR];

  if (!serialized) {
    return undefined;
  }

  const graph = deserializeRuntimeGraph(serialized);
  const secretPayload = processEnv[CNOS_SECRET_PAYLOAD_ENV_VAR];
  const sessionKey = processEnv[CNOS_SESSION_KEY_ENV_VAR];

  if (secretPayload && sessionKey) {
    const decrypted = decryptSecretPayload(secretPayload, sessionKey);

    for (const [key, value] of Object.entries(decrypted)) {
      const entry = graph.entries.get(key);

      if (entry) {
        entry.value = value;
      }
    }
  }

  return graph;
}

export function readServerProjectionFromEnv(
  processEnv: Record<string, string | undefined> = process.env,
): ServerProjection | undefined {
  const serialized = processEnv[CNOS_PROJECTION_ENV_VAR];

  if (!serialized) {
    return undefined;
  }

  return deserializeServerProjection(serialized);
}

export function graphRequiresSecretHydration(graph: ResolvedGraph): boolean {
  return Array.from(graph.entries.values()).some((entry) => entry.namespace === 'secret' && isSecretReference(entry.value));
}
