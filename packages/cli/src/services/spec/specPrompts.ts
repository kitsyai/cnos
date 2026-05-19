import readline from 'node:readline';

import type { ConfigSpecRule } from '@kitsy/cnos-core';

import type { ParsedSpecSetInput } from './specSetInput.js';
import { assertValidSpecPattern } from './patternValidation.js';

const SPEC_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;

function parseJsonOrString(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
      });
    },
    close(): void {
      rl.close();
    },
  };
}

export function isInteractiveSpecPromptMode(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptSpecSetInput(logicalKey: string): Promise<ParsedSpecSetInput> {
  const prompt = createPrompt();

  try {
    process.stdout.write(`Config spec for ${logicalKey}\n`);
    const set: Partial<ConfigSpecRule> = {};
    const type = (await prompt.ask(`Type (${SPEC_TYPES.join('|')}) [skip]: `)).toLowerCase();

    if (type) {
      if (!SPEC_TYPES.includes(type as (typeof SPEC_TYPES)[number])) {
        throw new Error(`Unsupported type: ${type}`);
      }

      set.type = type as NonNullable<ConfigSpecRule['type']>;
    }

    const required = (await prompt.ask('Required? (y/n) [skip]: ')).toLowerCase();
    if (required === 'y' || required === 'yes') {
      set.required = true;
    } else if (required === 'n' || required === 'no') {
      set.required = false;
    }

    const defaultValue = await prompt.ask('Default value (JSON or string) [skip]: ');
    if (defaultValue) {
      set.default = parseJsonOrString(defaultValue);
    }

    const enumValue = await prompt.ask('Enum values as JSON array [skip]: ');
    if (enumValue) {
      const parsed = parseJsonOrString(enumValue);
      if (!Array.isArray(parsed)) {
        throw new Error('Enum must be a JSON array');
      }

      if (parsed.length === 0) {
        throw new Error('Enum must not be empty');
      }

      set.enum = parsed;
    }

    const pattern = await prompt.ask('Pattern (regex string) [skip]: ');
    if (pattern) {
      assertValidSpecPattern(pattern);
      set.pattern = pattern;
    }

    const summary = await prompt.ask('Summary [skip]: ');
    if (summary) {
      set.summary = summary;
    }

    const description = await prompt.ask('Description [skip]: ');
    if (description) {
      set.description = description;
    }

    const examples = await prompt.ask('Examples as JSON array [skip]: ');
    if (examples) {
      const parsed = parseJsonOrString(examples);
      if (!Array.isArray(parsed)) {
        throw new Error('Examples must be a JSON array');
      }

      set.examples = parsed;
    }

    const usedBy = await prompt.ask('Used by (comma separated) [skip]: ');
    if (usedBy) {
      const values = usedBy
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (values.length > 0) {
        set.usedBy = values;
      }
    }

    const deprecated = (await prompt.ask('Deprecated? (y/n) [skip]: ')).toLowerCase();
    if (deprecated === 'y' || deprecated === 'yes') {
      set.deprecated = true;
    } else if (deprecated === 'n' || deprecated === 'no') {
      set.deprecated = false;
    }

    const deprecationMessage = await prompt.ask('Deprecation message [skip]: ');
    if (deprecationMessage) {
      set.deprecationMessage = deprecationMessage;
      set.deprecated = true;
    }

    return {
      set,
      clear: [],
      hasFieldFlags: Object.keys(set).length > 0,
      cliArgs: [],
    };
  } finally {
    prompt.close();
  }
}
