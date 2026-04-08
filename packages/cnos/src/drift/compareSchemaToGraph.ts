import type { CnosRuntime, ResolvedEntry } from '@kitsy/cnos-core';
import type { SchemaRule } from '@kitsy/cnos-core';

export interface DriftIssue {
  key: string;
  expectedType?: string;
  actualType?: string;
  value?: unknown;
  sourceFile?: string;
}

export interface DriftReport {
  profile: string;
  workspace: string;
  missing: DriftIssue[];
  undeclared: DriftIssue[];
  mismatches: DriftIssue[];
  defaultsApplied: DriftIssue[];
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
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

function isSchemaDefault(entry: ResolvedEntry): boolean {
  return entry.winner.metadata?.schemaDefault === true;
}

function shouldTrackKey(key: string): boolean {
  return key.startsWith('value.') || key.startsWith('secret.');
}

function isTransientRuntimeSource(entry: ResolvedEntry): boolean {
  return entry.winner.sourceId === 'process-env' || entry.winner.sourceId === 'cli-args';
}

export function compareSchemaToGraph(runtime: CnosRuntime): DriftReport {
  const schema = runtime.manifest.schema;
  const missing: DriftIssue[] = [];
  const mismatches: DriftIssue[] = [];
  const defaultsApplied: DriftIssue[] = [];

  for (const [key, rule] of Object.entries(schema).sort(([left], [right]) => left.localeCompare(right))) {
    const entry = runtime.graph.entries.get(key);

    if (!entry) {
      if (rule.required && rule.default === undefined) {
        missing.push({
          key,
          ...(rule.type
            ? {
                expectedType: rule.type,
              }
            : {}),
        });
      }

      continue;
    }

    if (isSchemaDefault(entry)) {
      defaultsApplied.push({
        key,
        value: entry.value,
      });
    }

    const actualValue = entry.winner.value;

    if (!matchesType(actualValue, rule.type)) {
      mismatches.push({
        key,
        ...(rule.type
          ? {
              expectedType: rule.type,
            }
          : {}),
        actualType: describeValueType(actualValue),
        value: actualValue,
        ...(entry.winner.origin?.file
          ? {
              sourceFile: entry.winner.origin.file,
            }
          : {}),
      });
    }
  }

  const undeclared = Array.from(runtime.graph.entries.values())
    .filter(
      (entry) =>
        shouldTrackKey(entry.key) &&
        !schema[entry.key] &&
        !isSchemaDefault(entry) &&
        !isTransientRuntimeSource(entry),
    )
    .map((entry) => {
      const issue: DriftIssue = {
        key: entry.key,
        value: entry.winner.value,
        actualType: describeValueType(entry.winner.value),
      };

      if (entry.winner.origin?.file) {
        issue.sourceFile = entry.winner.origin.file;
      }

      return issue;
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    profile: runtime.graph.profile,
    workspace: runtime.graph.workspace.workspaceId,
    missing,
    undeclared,
    mismatches,
    defaultsApplied,
  };
}
