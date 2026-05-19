import { consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { assertWritableConfigRoot } from '../services/rootAccess.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { formatSpecDoctorResult, runSpecDoctor } from '../services/spec/specDoctor.js';
import {
  deleteSpecEntry,
  listSpecEntries,
  setSpecEntry,
  showSpecEntry,
} from '../services/spec/manifestSpecStore.js';
import { isInteractiveSpecPromptMode, promptSpecSetInput } from '../services/spec/specPrompts.js';
import { parseSpecSetInput } from '../services/spec/specSetInput.js';

type SpecAction = 'list' | 'show' | 'set' | 'delete' | 'doctor';

function normalizeSpecAction(args: string[]): { action: SpecAction; tail: string[] } {
  const [action = 'list', ...tail] = args;

  if (['list', 'show', 'set', 'delete', 'remove', 'doctor'].includes(action)) {
    return {
      action: action === 'remove' ? 'delete' : (action as SpecAction),
      tail,
    };
  }

  return {
    action: 'show',
    tail: args,
  };
}

function validateNamespaceQualifiedKey(logicalKey: string): string {
  const key = logicalKey.trim();

  if (!key.includes('.')) {
    throw new Error(`Spec key must be namespace-qualified: ${logicalKey}`);
  }

  const namespace = key.slice(0, key.indexOf('.'));
  const keyPath = key.slice(key.indexOf('.') + 1);

  if (!namespace || !keyPath) {
    throw new Error(`Spec key must be namespace-qualified: ${logicalKey}`);
  }

  return key;
}

function hasFieldFlag(cliArgs: string[]): boolean {
  const clearFlags = new Set([
    '--clear-default',
    '--clear-enum',
    '--clear-pattern',
    '--clear-summary',
    '--clear-description',
    '--clear-examples',
    '--clear-used-by',
    '--clear-deprecated',
    '--clear-deprecation-message',
  ]);
  const optionFlags = new Set([
    '--type',
    '--default',
    '--enum',
    '--pattern',
    '--summary',
    '--description',
    '--example',
    '--used-by',
    '--deprecation-message',
  ]);
  const toggleFlags = new Set(['--required', '--optional', '--deprecated']);

  return cliArgs.some((arg) => {
    const raw = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    return clearFlags.has(raw) || optionFlags.has(raw) || toggleFlags.has(raw);
  });
}

function assertSecretSafeSpecSet(logicalKey: string, set: Record<string, unknown>): void {
  if (!logicalKey.startsWith('secret.')) {
    return;
  }

  const forbidden = ['default', 'enum', 'examples'].filter((field) => Object.prototype.hasOwnProperty.call(set, field));

  if (forbidden.length > 0) {
    throw new Error(
      `Cannot set ${forbidden.join(', ')} for secret spec key ${logicalKey}. Store secret values in the vault, not schema metadata.`,
    );
  }
}

export async function runSpec(args: string[] = [], options: RuntimeServiceOptions = {}): Promise<string> {
  const { action, tail } = normalizeSpecAction(args);
  const cliArgs = [...(options.cliArgs ?? [])];

  if (action === 'list') {
    const prefix = consumeOption(cliArgs, '--prefix');

    if (cliArgs.length > 0) {
      throw new Error(`Unsupported spec list options: ${cliArgs.join(' ')}`);
    }

    const result = await listSpecEntries({
      ...options,
      ...(prefix
        ? {
            prefix,
          }
        : {}),
    });

    if (options.json) {
      return printJson(result);
    }

    return result.entries.map((entry) => entry.key).join('\n');
  }

  if (action === 'show') {
    const logicalKey = validateNamespaceQualifiedKey(tail[0] ?? '');

    if (tail.length > 1) {
      throw new Error('spec show accepts exactly one <logicalKey>');
    }

    if (cliArgs.length > 0) {
      throw new Error(`Unsupported spec show options: ${cliArgs.join(' ')}`);
    }

    const result = await showSpecEntry(logicalKey, options);

    if (!result.rule) {
      throw new Error(`No spec entry found for ${logicalKey}`);
    }

    if (options.json) {
      return printJson(result);
    }

    return [
      `${result.key}:`,
      ...Object.entries(result.rule).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
    ].join('\n');
  }

  if (action === 'set') {
    const logicalKey = validateNamespaceQualifiedKey(tail[0] ?? '');

    if (tail.length > 1) {
      throw new Error('spec set accepts exactly one <logicalKey>');
    }

    const fieldFlagPresent = hasFieldFlag(cliArgs);

    if (!fieldFlagPresent && options.json) {
      throw new Error('spec set --json requires field flags; interactive JSON mode is not supported.');
    }

    let input = parseSpecSetInput(logicalKey, cliArgs);

    if (!input.hasFieldFlags) {
      if (!isInteractiveSpecPromptMode()) {
        throw new Error('spec set without field flags requires an interactive TTY.');
      }

      input = await promptSpecSetInput(logicalKey);
    }

    if (Object.keys(input.set).length === 0 && input.clear.length === 0) {
      throw new Error('spec set requires at least one field to set or clear.');
    }

    assertSecretSafeSpecSet(logicalKey, input.set as Record<string, unknown>);

    if (input.cliArgs.length > 0) {
      throw new Error(`Unsupported spec set options: ${input.cliArgs.join(' ')}`);
    }

    await assertWritableConfigRoot(`update spec ${logicalKey}`, options);
    const result = await setSpecEntry(logicalKey, {
      ...options,
      set: input.set,
      clear: input.clear,
    });

    if (options.json) {
      return printJson(result);
    }

    return `${result.action} spec ${result.key}`;
  }

  if (action === 'doctor') {
    const fillMissing = cliArgs.includes('--fill-missing');
    const reviewAll = cliArgs.includes('--review-all');

    if (fillMissing && reviewAll) {
      throw new Error('spec doctor accepts only one write mode: --fill-missing or --review-all');
    }

    const mode = fillMissing ? 'fill-missing' : reviewAll ? 'review-all' : 'report';

    if (mode !== 'report' && options.json) {
      throw new Error(`spec doctor --${mode} does not support --json in Phases 1-3.`);
    }

    if (cliArgs.some((value) => !['--fill-missing', '--review-all'].includes(value))) {
      throw new Error(`Unsupported spec doctor options: ${cliArgs.join(' ')}`);
    }

    if (mode !== 'report') {
      await assertWritableConfigRoot(`run spec doctor --${mode}`, options);
    }

    const outcome = await runSpecDoctor(mode, options);

    if (outcome.blocking) {
      process.exitCode = 1;
    }

    if (options.json) {
      return printJson(outcome.result);
    }

    return formatSpecDoctorResult(outcome.result);
  }

  const logicalKey = validateNamespaceQualifiedKey(tail[0] ?? '');

  if (tail.length > 1) {
    throw new Error('spec delete accepts exactly one <logicalKey>');
  }

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported spec delete options: ${cliArgs.join(' ')}`);
  }

  await assertWritableConfigRoot(`delete spec ${logicalKey}`, options);
  const result = await deleteSpecEntry(logicalKey, options);

  if (options.json) {
    return printJson(result);
  }

  return result.deleted ? `deleted spec ${result.key}` : `no spec entry found for ${result.key}`;
}
