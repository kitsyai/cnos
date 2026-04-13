import type { ConfigEntry, ResolvedEntry, ResolvedGraph } from '../types/core.js';
import type { ValidationIssue } from '../types/plugin.js';
import type { SchemaRule } from '../types/schema.js';
import { isDerivedValue } from '../derive/evaluator.js';

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
}

function coerceBoolean(value: string): boolean | undefined {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

function coerceValue(value: unknown, rule: SchemaRule): unknown {
  if (typeof value !== 'string' || !rule.type) {
    return value;
  }

  switch (rule.type) {
    case 'number': {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    }
    case 'boolean':
      return coerceBoolean(value) ?? value;
    case 'object':
    case 'array': {
      try {
        const parsed = JSON.parse(value);

        if (rule.type === 'array' && Array.isArray(parsed)) {
          return parsed;
        }

        if (rule.type === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }

        return value;
      } catch {
        return value;
      }
    }
    default:
      return value;
  }
}

function matchesType(value: unknown, type?: SchemaRule['type']): boolean {
  if (!type) {
    return true;
  }

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

export interface ApplySchemaResult {
  graph: ResolvedGraph;
  issues: ValidationIssue[];
}

export function applySchemaRules(
  graph: ResolvedGraph,
  schema: Record<string, SchemaRule>,
): ApplySchemaResult {
  const nextEntries = new Map(graph.entries);
  const issues: ValidationIssue[] = [];

  for (const [key, rule] of Object.entries(schema).sort(([left], [right]) => left.localeCompare(right))) {
    const resolvedEntry = nextEntries.get(key);

    if (!resolvedEntry) {
      if (rule.default !== undefined) {
        const defaultEntry: ConfigEntry = {
          key,
          value: rule.default,
          namespace: key.startsWith('secret.')
            ? 'secret'
            : key.startsWith('meta.')
              ? 'meta'
              : 'value',
          sourceId: 'schema-default',
          pluginId: 'basic-schema',
          workspaceId: graph.workspace.workspaceId,
          metadata: {
            schemaDefault: true,
          },
        };

        nextEntries.set(key, {
          key,
          value: rule.default,
          namespace: defaultEntry.namespace,
          winner: defaultEntry,
          overridden: [],
        });
        continue;
      }

      if (rule.required) {
        issues.push({
          code: 'schema.required',
          key,
          message: `Missing required config key: ${key}`,
        });
      }

      continue;
    }

    if (isDerivedValue(resolvedEntry.value)) {
      nextEntries.set(key, resolvedEntry);
      continue;
    }

    const coercedValue = coerceValue(resolvedEntry.value, rule);
    const nextResolvedEntry: ResolvedEntry =
      coercedValue === resolvedEntry.value
        ? resolvedEntry
        : {
            ...resolvedEntry,
            value: coercedValue,
          };

    if (!matchesType(coercedValue, rule.type)) {
      issues.push({
        code: 'schema.type',
        key,
        message: `Config key ${key} expected type ${rule.type} but got ${describeValueType(coercedValue)}`,
      });
    }

    if (rule.enum && !enumMatches(coercedValue, rule.enum)) {
      issues.push({
        code: 'schema.enum',
        key,
        message: `Config key ${key} must be one of ${rule.enum.map((entry) => JSON.stringify(entry)).join(', ')}`,
      });
    }

    if (rule.pattern) {
      if (typeof coercedValue !== 'string') {
        issues.push({
          code: 'schema.pattern',
          key,
          message: `Config key ${key} must be a string to match pattern ${rule.pattern}`,
        });
      } else if (!new RegExp(rule.pattern).test(coercedValue)) {
        issues.push({
          code: 'schema.pattern',
          key,
          message: `Config key ${key} does not match pattern ${rule.pattern}`,
        });
      }
    }

    nextEntries.set(key, nextResolvedEntry);
  }

  return {
    graph: {
      ...graph,
      entries: nextEntries,
    },
    issues,
  };
}
