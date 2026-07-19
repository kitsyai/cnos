import { createHash } from 'node:crypto';

/**
 * Deterministically serialize a JSON value with object keys sorted, so that two
 * structurally-equal documents always produce the same string (and thus the same hash).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * Content-addressed revision hash of a document: `sha256:<hex>` over the canonical JSON.
 * Identical documents always hash identically (dedupe); any change yields a new revision.
 */
export function revisionHash(document: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(document)).digest('hex');
  return `sha256:${digest}`;
}
