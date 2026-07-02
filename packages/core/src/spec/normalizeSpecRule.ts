import { CnosManifestError } from '../errors.js';
import type { ConfigSpecFormat, ConfigSpecRule, ConfigSpecValueType, OverridePrioritySource } from '../types/spec.js';

const ALLOWED_TYPES = new Set<ConfigSpecValueType>(['string', 'number', 'boolean', 'object', 'array']);
const ALLOWED_FORMATS = new Set<ConfigSpecFormat>(['richtext', 'pem']);
const ALLOWED_PRIORITY_SOURCES = new Set<OverridePrioritySource>(['arg', 'env', 'cnos']);
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

  if (candidate.format !== undefined) {
    if (typeof candidate.format !== 'string' || !ALLOWED_FORMATS.has(candidate.format as ConfigSpecFormat)) {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: unsupported format "${String(candidate.format)}".`);
    }
    normalized.format = candidate.format as ConfigSpecFormat;
  }

  // env: string | string[] → normalized as string[]
  if (candidate.env !== undefined) {
    if (typeof candidate.env === 'string') {
      const trimmed = candidate.env.trim();
      if (trimmed) normalized.env = [trimmed];
    } else if (Array.isArray(candidate.env)) {
      const envVars = candidate.env
        .filter((e): e is string => typeof e === 'string')
        .map((e) => e.trim())
        .filter(Boolean);
      if (envVars.length > 0) normalized.env = envVars;
    } else {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "env" must be a string or string array.`);
    }
  }

  // arg: string | string[] → normalized as string[]
  if (candidate.arg !== undefined) {
    if (typeof candidate.arg === 'string') {
      const trimmed = candidate.arg.trim();
      if (trimmed) normalized.arg = [trimmed];
    } else if (Array.isArray(candidate.arg)) {
      const args = candidate.arg
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter(Boolean);
      if (args.length > 0) normalized.arg = args;
    } else {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "arg" must be a string or string array.`);
    }
  }

  if (candidate.priority !== undefined) {
    if (!Array.isArray(candidate.priority)) {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "priority" must be an array.`);
    }
    const sources = candidate.priority as unknown[];
    const invalid = sources.find((s) => typeof s !== 'string' || !ALLOWED_PRIORITY_SOURCES.has(s as OverridePrioritySource));
    if (invalid !== undefined) {
      throw new CnosManifestError(`Invalid schema rule for ${logicalKey}: "priority" entries must be "arg", "env", or "cnos".`);
    }
    normalized.priority = sources as OverridePrioritySource[];
  }

  return normalized;
}
