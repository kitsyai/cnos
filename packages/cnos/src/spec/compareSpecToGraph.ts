import type { CnosRuntime, ConfigSpecRule, ResolvedEntry } from '@kitsy/cnos-core';

export type SpecComparisonStatus =
  | 'missing_required'
  | 'undeclared'
  | 'type_mismatch'
  | 'enum_mismatch'
  | 'pattern_mismatch'
  | 'default_applied'
  | 'deprecated_in_use';

export interface SpecComparisonIssue {
  key: string;
  status: SpecComparisonStatus;
  expectedType?: string;
  actualType?: string;
  value?: unknown;
  sourceFile?: string;
  summary?: string;
  pattern?: string;
}

export interface SpecComparisonSummary {
  missingRequired: number;
  undeclared: number;
  typeMismatch: number;
  enumMismatch: number;
  patternMismatch: number;
  defaultApplied: number;
  deprecatedInUse: number;
}

export interface SpecComparisonReport {
  profile: string;
  workspace: string;
  summary: SpecComparisonSummary;
  issues: SpecComparisonIssue[];
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

function matchesType(value: unknown, type?: ConfigSpecRule['type']): boolean {
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

function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // Invalid schema patterns should be rejected during manifest normalization.
    // Keep comparison defensive so diagnostics do not crash on malformed inputs.
    return false;
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

function buildSummary(issues: SpecComparisonIssue[]): SpecComparisonSummary {
  return {
    missingRequired: issues.filter((issue) => issue.status === 'missing_required').length,
    undeclared: issues.filter((issue) => issue.status === 'undeclared').length,
    typeMismatch: issues.filter((issue) => issue.status === 'type_mismatch').length,
    enumMismatch: issues.filter((issue) => issue.status === 'enum_mismatch').length,
    patternMismatch: issues.filter((issue) => issue.status === 'pattern_mismatch').length,
    defaultApplied: issues.filter((issue) => issue.status === 'default_applied').length,
    deprecatedInUse: issues.filter((issue) => issue.status === 'deprecated_in_use').length,
  };
}

export function compareSpecToGraph(runtime: CnosRuntime): SpecComparisonReport {
  const schema = runtime.manifest.schema;
  const issues: SpecComparisonIssue[] = [];

  for (const [key, rule] of Object.entries(schema).sort(([left], [right]) => left.localeCompare(right))) {
    const entry = runtime.graph.entries.get(key);
    const summary = rule.summary;

    if (!entry) {
      if (rule.required && rule.default === undefined) {
        issues.push({
          key,
          status: 'missing_required',
          ...(rule.type
            ? {
                expectedType: rule.type,
              }
            : {}),
          ...(summary
            ? {
                summary,
              }
            : {}),
        });
      }

      continue;
    }

    if (isSchemaDefault(entry)) {
      issues.push({
        key,
        status: 'default_applied',
        value: entry.value,
        ...(summary
          ? {
              summary,
            }
          : {}),
      });
    }

    const actualValue = entry.winner.value;

    if (!matchesType(actualValue, rule.type)) {
      issues.push({
        key,
        status: 'type_mismatch',
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
        ...(summary
          ? {
              summary,
            }
          : {}),
      });
    }

    if (rule.enum && !enumMatches(actualValue, rule.enum)) {
      issues.push({
        key,
        status: 'enum_mismatch',
        value: actualValue,
        ...(summary
          ? {
              summary,
            }
          : {}),
      });
    }

    if (rule.pattern) {
      if (typeof actualValue !== 'string' || !matchesPattern(rule.pattern, actualValue)) {
        issues.push({
          key,
          status: 'pattern_mismatch',
          value: actualValue,
          pattern: rule.pattern,
          ...(summary
            ? {
                summary,
              }
            : {}),
        });
      }
    }

    if (rule.deprecated) {
      issues.push({
        key,
        status: 'deprecated_in_use',
        value: actualValue,
        ...(summary
          ? {
              summary,
            }
          : {}),
      });
    }
  }

  const undeclaredIssues = Array.from(runtime.graph.entries.values())
    .filter(
      (entry) =>
        shouldTrackKey(entry.key) &&
        !schema[entry.key] &&
        !isSchemaDefault(entry) &&
        !isTransientRuntimeSource(entry),
    )
    .map((entry): SpecComparisonIssue => ({
      key: entry.key,
      status: 'undeclared',
      value: entry.winner.value,
      actualType: describeValueType(entry.winner.value),
      ...(entry.winner.origin?.file
        ? {
            sourceFile: entry.winner.origin.file,
          }
        : {}),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  const allIssues = [...issues, ...undeclaredIssues].sort((left, right) => left.key.localeCompare(right.key));

  return {
    profile: runtime.graph.profile,
    workspace: runtime.graph.workspace.workspaceId,
    summary: buildSummary(allIssues),
    issues: allIssues,
  };
}
