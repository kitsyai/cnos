import type { ConfigSpecRule } from './spec.js';

/**
 * Backward-compatible alias for the manifest schema rule type.
 * Keep this export stable for existing importers.
 */
export type SchemaRule = ConfigSpecRule;
