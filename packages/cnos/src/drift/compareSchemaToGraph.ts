import type { CnosRuntime } from '@kitsy/cnos-core';

import { compareSpecToGraph } from '../spec/compareSpecToGraph.js';

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

export function compareSchemaToGraph(runtime: CnosRuntime): DriftReport {
  const report = compareSpecToGraph(runtime);
  const missing = report.issues
    .filter((issue) => issue.status === 'missing_required')
    .map(
      (issue): DriftIssue => ({
        key: issue.key,
        ...(issue.expectedType
          ? {
              expectedType: issue.expectedType,
            }
          : {}),
      }),
    );
  const undeclared = report.issues
    .filter((issue) => issue.status === 'undeclared')
    .map(
      (issue): DriftIssue => ({
        key: issue.key,
        value: issue.value,
        ...(issue.actualType
          ? {
              actualType: issue.actualType,
            }
          : {}),
        ...(issue.sourceFile
          ? {
              sourceFile: issue.sourceFile,
            }
          : {}),
      }),
    );
  const mismatches = report.issues
    .filter((issue) => issue.status === 'type_mismatch')
    .map(
      (issue): DriftIssue => ({
        key: issue.key,
        ...(issue.expectedType
          ? {
              expectedType: issue.expectedType,
            }
          : {}),
        ...(issue.actualType
          ? {
              actualType: issue.actualType,
            }
          : {}),
        value: issue.value,
        ...(issue.sourceFile
          ? {
              sourceFile: issue.sourceFile,
            }
          : {}),
      }),
    );
  const defaultsApplied = report.issues
    .filter((issue) => issue.status === 'default_applied')
    .map(
      (issue): DriftIssue => ({
        key: issue.key,
        value: issue.value,
      }),
    );

  return {
    profile: report.profile,
    workspace: report.workspace,
    missing,
    undeclared,
    mismatches,
    defaultsApplied,
  };
}
