import { CnosManifestError } from '../errors.js';
import type { ConfigSpecRule, ConfigSpecValueType } from '../types/spec.js';

const ALLOWED_TYPES = new Set<ConfigSpecValueType>(['string', 'number', 'boolean', 'object', 'array']);
const SECRET_FORBIDDEN_FIELDS = ['default', 'examples', 'enum'] as const;

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function normalizeOptionalString(
  value: unknown,
  fieldName: string,
  logicalKey: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "${fieldName}" must be a string.`);
  }

  const nextValue = value.trim();
  return nextValue.length > 0 ? nextValue : undefined;
}

function normalizeStringArray(
  value: unknown,
  fieldName: string,
  logicalKey: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "${fieldName}" must be an array.`);
  }

  const nextValue = value
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new CnosManifestError(
          `Invalid schema rule for ${logicalKey}: "${fieldName}" entries must be strings.`,
        );
      }

      return entry.trim();
    })
    .filter(Boolean);

  return nextValue.length > 0 ? nextValue : undefined;
}

function normalizeUnknownArray(
  value: unknown,
  fieldName: string,
  logicalKey: string,
): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "${fieldName}" must be an array.`);
  }

  return value.length > 0 ? value : undefined;
}

function assertValidPatternRegex(
  pattern: string,
  logicalKey: string,
): void {
  try {
    void new RegExp(pattern);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CnosManifestError(
      `Invalid schema rule for ${logicalKey}: "pattern" must be a valid regex (${reason}).`,
    );
  }
}

function assertSecretRuleSafety(
  logicalKey: string,
  rule: Record<string, unknown>,
): void {
  if (!logicalKey.startsWith('secret.')) {
    return;
  }

  const offendingFields = SECRET_FORBIDDEN_FIELDS.filter((field) => hasOwn(rule, field));

  if (offendingFields.length === 0) {
    return;
  }

  throw new CnosManifestError(
    `Invalid schema rule for ${logicalKey}: secret specs cannot include ${offendingFields.join(', ')}. ` +
      `Store secret values in the vault, not schema metadata. Remove ${offendingFields
        .map((field) => `schema.${logicalKey}.${field}`)
        .join(', ')} to continue.`,
  );
}

export function normalizeSpecRule(
  logicalKey: string,
  rule: unknown,
): ConfigSpecRule {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: expected an object.`);
  }

  const candidate = rule as Record<string, unknown>;
  assertSecretRuleSafety(logicalKey, candidate);
  const normalized: ConfigSpecRule = {};

  if (candidate.type !== undefined) {
    if (typeof candidate.type !== 'string' || !ALLOWED_TYPES.has(candidate.type as ConfigSpecValueType)) {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: unsupported type "${String(candidate.type)}".`);
    }

    normalized.type = candidate.type as ConfigSpecValueType;
  }

  if (candidate.required !== undefined) {
    if (typeof candidate.required !== 'boolean') {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "required" must be a boolean.`);
    }

    normalized.required = candidate.required;
  }

  if (hasOwn(candidate, 'default')) {
    normalized.default = candidate.default;
  }

  const normalizedEnum = normalizeUnknownArray(candidate.enum, 'enum', logicalKey);
  if (normalizedEnum !== undefined) {
    normalized.enum = normalizedEnum;
  }

  const normalizedPattern = normalizeOptionalString(candidate.pattern, 'pattern', logicalKey);
  if (normalizedPattern !== undefined) {
    assertValidPatternRegex(normalizedPattern, logicalKey);
    normalized.pattern = normalizedPattern;
  }

  const normalizedSummary = normalizeOptionalString(candidate.summary, 'summary', logicalKey);
  if (normalizedSummary !== undefined) {
    normalized.summary = normalizedSummary;
  }

  const normalizedDescription = normalizeOptionalString(candidate.description, 'description', logicalKey);
  if (normalizedDescription !== undefined) {
    normalized.description = normalizedDescription;
  }

  const normalizedExamples = normalizeUnknownArray(candidate.examples, 'examples', logicalKey);
  if (normalizedExamples !== undefined) {
    normalized.examples = normalizedExamples;
  }

  const normalizedUsedBy = normalizeStringArray(candidate.usedBy, 'usedBy', logicalKey);
  if (normalizedUsedBy !== undefined) {
    normalized.usedBy = normalizedUsedBy;
  }

  if (candidate.deprecated !== undefined) {
    if (typeof candidate.deprecated !== 'boolean') {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "deprecated" must be a boolean.`);
    }

    normalized.deprecated = candidate.deprecated;
  }

  const normalizedDeprecationMessage = normalizeOptionalString(
    candidate.deprecationMessage,
    'deprecationMessage',
    logicalKey,
  );
  if (normalizedDeprecationMessage !== undefined) {
    normalized.deprecationMessage = normalizedDeprecationMessage;
  }

  return normalized;
}
