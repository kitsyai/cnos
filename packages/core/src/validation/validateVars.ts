import type { NormalizedManifest } from '../types/manifest.js';
import type { ValidationIssue } from '../types/plugin.js';
import type { DocumentFieldRule, DocumentSchemaDefinition } from '../types/var.js';

const VAR_PREFIX = 'var.';
const SECRET_PREFIX = 'secret.';

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
}

function matchesFieldType(value: unknown, type: DocumentFieldRule['type']): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    default:
      return typeof value === type;
  }
}

function enumMatches(value: unknown, allowed: unknown[]): boolean {
  const serialized = JSON.stringify(value);
  return allowed.some((candidate) => JSON.stringify(candidate) === serialized);
}

function testPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/**
 * Validate the `var.*` authoring model in a normalized manifest.
 *
 * Enforces: every var group references a declared source; every `var.*` schema rule
 * belongs to a declared group; `required: true` + `default` on the same rule is an error;
 * `document:` must reference a declared documents entry; varSource `auth`/`verify` values
 * must be `secret.*` refs; and `var.*` must never appear in public promotion.
 */
export function validateVarManifest(manifest: NormalizedManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const varSources = manifest.varSources ?? {};
  const vars = manifest.vars ?? {};
  const documents = manifest.documents ?? {};

  for (const [group, definition] of Object.entries(vars)) {
    if (!varSources[definition.source]) {
      issues.push({
        code: 'var.unknown-source',
        key: `${VAR_PREFIX}${group}`,
        message: `Var group "${group}" references undeclared varSource "${definition.source}". Declare it under varSources in .cnos/cnos.yml.`,
      });
    }
  }

  for (const [name, source] of Object.entries(varSources)) {
    for (const [slot, ref] of Object.entries(source.auth)) {
      if (!isSecretRef(ref)) {
        issues.push({
          code: 'var.auth-not-secret-ref',
          message: `varSource "${name}" auth "${slot}" must be a secret.* reference (got ${JSON.stringify(ref)}). Use a ref like secret.ops.token — never inline secret material.`,
        });
      }
    }

    if (source.verify !== undefined && !isSecretRef(source.verify)) {
      issues.push({
        code: 'var.auth-not-secret-ref',
        message: `varSource "${name}" verify must be a secret.* reference (got ${JSON.stringify(source.verify)}). Use a ref like secret.ops.verify_key — never inline secret material.`,
      });
    }
  }

  for (const [key, rule] of Object.entries(manifest.schema)) {
    if (!key.startsWith(VAR_PREFIX)) {
      continue;
    }

    const group = key.split('.')[1];

    if (!group || !vars[group]) {
      issues.push({
        code: 'var.unknown-group',
        key,
        message: `Schema rule "${key}" is not under a declared var group. Declare "${group ?? ''}" under vars in .cnos/cnos.yml.`,
      });
    }

    if (rule.required === true && rule.default !== undefined) {
      issues.push({
        code: 'var.required-and-default',
        key,
        message: `Schema rule "${key}" sets both required: true and a default. A mandatory var cannot also declare a fallback default — pick one.`,
      });
    }

    if (rule.document !== undefined && !documents[rule.document]) {
      issues.push({
        code: 'var.unknown-document',
        key,
        message: `Schema rule "${key}" references undeclared document schema "${rule.document}". Declare it under documents in .cnos/cnos.yml.`,
      });
    }
  }

  for (const key of manifest.public.promote) {
    if (key.startsWith(VAR_PREFIX)) {
      issues.push({
        code: 'var.public-exposure',
        key,
        message: `var.* runtime configuration must never reach public or browser surfaces. Remove "${key}" from public.promote in .cnos/cnos.yml.`,
      });
    }
  }

  return issues;
}

export interface DocumentValidationOptions {
  /** Schema id used in messages (e.g. `agentic-lanes/v1`). */
  schemaId?: string;
  /** Logical key path used to tag issues (e.g. `var.agentic.lanes.vinci`). */
  path?: string;
}

/**
 * Validate a whole JS object against a document schema. Rejects wrong-typed fields,
 * missing required fields, and (when `additionalProperties` is false) unknown fields.
 *
 * Exported for reuse by later phases (server-side create/validate and consumer-side ingest).
 */
export function validateDocumentValue(
  value: unknown,
  schema: DocumentSchemaDefinition,
  options: DocumentValidationOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const label = options.schemaId ? `document "${options.schemaId}"` : 'document';
  const tag = options.path ? { key: options.path } : {};

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({
      code: 'document.type',
      ...tag,
      message: `Expected ${label} to be an object, got ${describeType(value)}.`,
    });
    return issues;
  }

  const object = value as Record<string, unknown>;

  for (const [field, rule] of Object.entries(schema.fields)) {
    const present = Object.prototype.hasOwnProperty.call(object, field) && object[field] !== undefined;

    if (!present) {
      if (rule.required) {
        issues.push({
          code: 'document.required',
          ...tag,
          message: `Missing required field "${field}" in ${label}.`,
        });
      }
      continue;
    }

    const fieldValue = object[field];

    if (!matchesFieldType(fieldValue, rule.type)) {
      issues.push({
        code: 'document.type',
        ...tag,
        message: `Field "${field}" in ${label} expected type ${rule.type} but got ${describeType(fieldValue)}.`,
      });
    }

    if (rule.enum && !enumMatches(fieldValue, rule.enum)) {
      issues.push({
        code: 'document.enum',
        ...tag,
        message: `Field "${field}" in ${label} must be one of ${rule.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`,
      });
    }

    if (rule.pattern !== undefined) {
      if (typeof fieldValue !== 'string') {
        issues.push({
          code: 'document.pattern',
          ...tag,
          message: `Field "${field}" in ${label} must be a string to match pattern ${rule.pattern}.`,
        });
      } else if (!testPattern(rule.pattern, fieldValue)) {
        issues.push({
          code: 'document.pattern',
          ...tag,
          message: `Field "${field}" in ${label} does not match pattern ${rule.pattern} (or the pattern is invalid).`,
        });
      }
    }
  }

  if (schema.additionalProperties === false) {
    for (const field of Object.keys(object)) {
      if (!Object.prototype.hasOwnProperty.call(schema.fields, field)) {
        issues.push({
          code: 'document.unknown-field',
          ...tag,
          message: `Unknown field "${field}" in ${label} is not allowed (additionalProperties: false).`,
        });
      }
    }
  }

  return issues;
}
