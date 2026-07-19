import type { NormalizedManifest } from '../types/manifest.js';

export const VAR_NAMESPACE_PREFIX = 'var.';

export function isVarKey(key: string): boolean {
  return key.startsWith(VAR_NAMESPACE_PREFIX);
}

/**
 * Scope-kind is syntactically decidable from the prefix-stripped scope string
 * (the var key/group minus the `var.` prefix): a GROUP is a single segment with no
 * dot (e.g. `agentic`, `user`); a KEY always contains a dot (e.g. `agentic.lanes.vinci`).
 * This is the single canonical rule shared by the TS server/SDK and the Go SDK.
 */
export function isVarGroupScope(scope: string): boolean {
  return !scope.includes('.');
}

/** The complement of {@link isVarGroupScope}: a scope that names a full var key. */
export function isVarKeyScope(scope: string): boolean {
  return scope.includes('.');
}

/**
 * Build the canonical `values` map for a delivered scope from its as-authored head
 * document. In every pull response and push payload `values` is ALWAYS keyed by the
 * full var key minus the `var.` prefix, for BOTH key- and group-scoped batches:
 *
 * - key scope (`agentic.lanes.vinci`) → wrap the document: `{ "<scope>": doc }`;
 * - group scope (`agentic`) → pass the document through (already keyed by full keys;
 *   the var-server validates that shape at revision-create time).
 */
export function toCanonicalVarValues(scope: string, document: unknown): Record<string, unknown> {
  if (isVarGroupScope(scope)) {
    return document !== null && typeof document === 'object' && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : {};
  }

  return { [scope]: document };
}

/**
 * Map a `var.<group>.<rest>` key to its statically projected `value.<group>.<rest>` twin.
 * The overlay reads the static value tier under the same group/rest path.
 */
export function toValueOverlayKey(varKey: string): string {
  return `value.${varKey.slice(VAR_NAMESPACE_PREFIX.length)}`;
}

export interface VarOverlayContext {
  /**
   * Runtime tier lookup — the active, valid runtime revision.
   *
   * W1 INTEGRATION POINT: there is no runtime var store yet, so this is left undefined
   * by the core runtime. The runtime SDK (W3) wires the live store/ingest cache here; the
   * precedence order below is final and does not change when it does.
   */
  readRuntimeVar?: (key: string) => unknown;
  /** Static value tier reader — resolves `value.<group>.<rest>`. */
  readValue: (valueKey: string) => unknown;
  manifest: NormalizedManifest;
}

/**
 * Resolve a `var.*` key through the overlay precedence:
 *
 *   1. active, valid runtime revision (W1: absent — integration point),
 *   2. statically projected `value.<group>.<rest>`,
 *   3. schema `default` if declared,
 *   4. otherwise `undefined`.
 *
 * `value.*` reads are never affected by this overlay — it exists only on the `var.*` path.
 */
export function resolveVarOverlay(key: string, context: VarOverlayContext): unknown {
  const runtimeValue = context.readRuntimeVar?.(key);

  if (runtimeValue !== undefined) {
    return runtimeValue;
  }

  const staticValue = context.readValue(toValueOverlayKey(key));

  if (staticValue !== undefined) {
    return staticValue;
  }

  const rule = context.manifest.schema[key];

  if (rule && rule.default !== undefined) {
    return rule.default;
  }

  return undefined;
}
