import { consumeFlag, consumeOption, consumeOptions } from '../../cli/commandOptions.js';
import type { ConfigSpecRule } from '@kitsy/cnos-core';
import { assertValidSpecPattern } from './patternValidation.js';

const SPEC_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
type ClearableField =
  | 'default'
  | 'enum'
  | 'pattern'
  | 'summary'
  | 'description'
  | 'examples'
  | 'usedBy'
  | 'deprecated'
  | 'deprecationMessage';

const SECRET_FORBIDDEN_FIELDS = ['default', 'enum', 'examples'] as const;

function parseJsonOrString(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function validateNamespaceQualifiedKey(logicalKey: string): void {
  const trimmed = logicalKey.trim();

  if (!trimmed.includes('.')) {
    throw new Error(`Spec key must be namespace-qualified: ${logicalKey}`);
  }

  const namespace = trimmed.slice(0, trimmed.indexOf('.'));
  const keyPath = trimmed.slice(trimmed.indexOf('.') + 1);

  if (!namespace || !keyPath) {
    throw new Error(`Spec key must be namespace-qualified: ${logicalKey}`);
  }
}

function parseSetOptionToField(
  option: string,
): ClearableField {
  switch (option) {
    case '--clear-default':
      return 'default';
    case '--clear-enum':
      return 'enum';
    case '--clear-pattern':
      return 'pattern';
    case '--clear-summary':
      return 'summary';
    case '--clear-description':
      return 'description';
    case '--clear-examples':
      return 'examples';
    case '--clear-used-by':
      return 'usedBy';
    case '--clear-deprecated':
      return 'deprecated';
    case '--clear-deprecation-message':
      return 'deprecationMessage';
    default:
      throw new Error(`Unknown clear option: ${option}`);
  }
}

function assertNoClearConflict(
  set: Partial<ConfigSpecRule>,
  clear: Set<ClearableField>,
): void {
  if (clear.has('default') && Object.prototype.hasOwnProperty.call(set, 'default')) {
    throw new Error('Cannot combine --default with --clear-default');
  }

  if (clear.has('enum') && Object.prototype.hasOwnProperty.call(set, 'enum')) {
    throw new Error('Cannot combine --enum with --clear-enum');
  }

  if (clear.has('pattern') && Object.prototype.hasOwnProperty.call(set, 'pattern')) {
    throw new Error('Cannot combine --pattern with --clear-pattern');
  }

  if (clear.has('summary') && Object.prototype.hasOwnProperty.call(set, 'summary')) {
    throw new Error('Cannot combine --summary with --clear-summary');
  }

  if (clear.has('description') && Object.prototype.hasOwnProperty.call(set, 'description')) {
    throw new Error('Cannot combine --description with --clear-description');
  }

  if (clear.has('examples') && Object.prototype.hasOwnProperty.call(set, 'examples')) {
    throw new Error('Cannot combine --example with --clear-examples');
  }

  if (clear.has('usedBy') && Object.prototype.hasOwnProperty.call(set, 'usedBy')) {
    throw new Error('Cannot combine --used-by with --clear-used-by');
  }

  if (clear.has('deprecated') && Object.prototype.hasOwnProperty.call(set, 'deprecated')) {
    throw new Error('Cannot combine --deprecated with --clear-deprecated');
  }

  if (clear.has('deprecated') && Object.prototype.hasOwnProperty.call(set, 'deprecationMessage')) {
    throw new Error('Cannot combine --clear-deprecated with --deprecation-message');
  }
}

function assertSecretSafeSpecSet(
  logicalKey: string,
  set: Partial<ConfigSpecRule>,
): void {
  if (!logicalKey.startsWith('secret.')) {
    return;
  }

  const offending = SECRET_FORBIDDEN_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(set, field));

  if (offending.length > 0) {
    throw new Error(
      `Cannot set ${offending.join(', ')} for secret spec key ${logicalKey}. Store secret values in the vault, not schema metadata.`,
    );
  }
}

export interface ParsedSpecSetInput {
  set: Partial<ConfigSpecRule>;
  clear: ClearableField[];
  hasFieldFlags: boolean;
  cliArgs: string[];
}

export function parseSpecSetInput(
  logicalKey: string,
  rawCliArgs: string[] = [],
): ParsedSpecSetInput {
  validateNamespaceQualifiedKey(logicalKey);
  const cliArgs = [...rawCliArgs];
  const clearOptions = [
    '--clear-default',
    '--clear-enum',
    '--clear-pattern',
    '--clear-summary',
    '--clear-description',
    '--clear-examples',
    '--clear-used-by',
    '--clear-deprecated',
    '--clear-deprecation-message',
  ] as const;
  const clear = new Set<ClearableField>();

  for (const option of clearOptions) {
    if (consumeFlag(cliArgs, option)) {
      clear.add(parseSetOptionToField(option));
    }
  }

  if (clear.has('deprecated')) {
    clear.add('deprecationMessage');
  }

  const set: Partial<ConfigSpecRule> = {};
  const type = consumeOption(cliArgs, '--type');

  if (type) {
    if (!SPEC_TYPES.has(type)) {
      throw new Error(`Unsupported --type value: ${type}`);
    }

    set.type = type as NonNullable<ConfigSpecRule['type']>;
  }

  const required = consumeFlag(cliArgs, '--required');
  const optional = consumeFlag(cliArgs, '--optional');

  if (required && optional) {
    throw new Error('Cannot combine --required and --optional');
  }

  if (required) {
    set.required = true;
  }

  if (optional) {
    set.required = false;
  }

  const defaultValue = consumeOption(cliArgs, '--default');
  if (defaultValue !== undefined) {
    set.default = parseJsonOrString(defaultValue);
  }

  const enumValue = consumeOption(cliArgs, '--enum');
  if (enumValue !== undefined) {
    const parsed = parseJsonOrString(enumValue);

    if (!Array.isArray(parsed)) {
      throw new Error('--enum must be a JSON array');
    }

    if (parsed.length === 0) {
      throw new Error('--enum must not be empty');
    }

    set.enum = parsed;
  }

  const pattern = consumeOption(cliArgs, '--pattern');
  if (pattern !== undefined) {
    assertValidSpecPattern(pattern);
    set.pattern = pattern;
  }

  const summary = consumeOption(cliArgs, '--summary');
  if (summary !== undefined) {
    set.summary = summary;
  }

  const description = consumeOption(cliArgs, '--description');
  if (description !== undefined) {
    set.description = description;
  }

  const examples = consumeOptions(cliArgs, '--example').map(parseJsonOrString);
  if (examples.length > 0) {
    set.examples = examples;
  }

  const usedBy = consumeOptions(cliArgs, '--used-by');
  if (usedBy.length > 0) {
    set.usedBy = usedBy;
  }

  const deprecated = consumeFlag(cliArgs, '--deprecated');
  if (deprecated) {
    set.deprecated = true;
  }

  const deprecationMessage = consumeOption(cliArgs, '--deprecation-message');
  if (deprecationMessage !== undefined) {
    set.deprecationMessage = deprecationMessage;
    set.deprecated = true;
  }

  if (clear.has('deprecationMessage') && Object.prototype.hasOwnProperty.call(set, 'deprecationMessage')) {
    throw new Error('Cannot combine --clear-deprecated with --deprecation-message');
  }

  if (clear.has('deprecationMessage') && Object.prototype.hasOwnProperty.call(set, 'deprecated') && set.deprecated) {
    // Allowed: --deprecated with --clear-deprecation-message
  }

  assertNoClearConflict(set, clear);
  assertSecretSafeSpecSet(logicalKey, set);

  return {
    set,
    clear: Array.from(clear),
    hasFieldFlags: Object.keys(set).length > 0 || clear.size > 0,
    cliArgs,
  };
}
