import type { ConfigSpecRule, CnosRuntime } from '@kitsy/cnos-core';
import { compareSpecToGraph } from '@kitsy/cnos/internal';

import { promptInput, promptMaskedInput } from '../maskedPrompt.js';
import type { RuntimeServiceOptions } from '../runtime.js';
import { createRuntimeService } from '../runtime.js';
import { defineValue, setSecret } from '../writes.js';

export type SpecDoctorMode = 'report' | 'fill-missing' | 'review-all';
export type SpecDoctorIssueStatus =
  | 'missing_required'
  | 'undeclared'
  | 'type_mismatch'
  | 'enum_mismatch'
  | 'pattern_mismatch'
  | 'default_applied'
  | 'deprecated_in_use';

export interface SpecDoctorIssue {
  key: string;
  status: SpecDoctorIssueStatus;
  expectedType?: string;
  actualType?: string;
  value?: unknown;
  sourceFile?: string;
  summary?: string;
}

export interface SpecDoctorSummary {
  missingRequired: number;
  undeclared: number;
  typeMismatch: number;
  enumMismatch: number;
  patternMismatch: number;
  defaultApplied: number;
  deprecatedInUse: number;
}

export interface SpecDoctorAction {
  key: string;
  result: 'applied' | 'skipped' | 'failed';
  reason?: string;
}

export interface SpecDoctorResult {
  workspace: string;
  profile: string;
  summary: SpecDoctorSummary;
  issues: SpecDoctorIssue[];
  mode: SpecDoctorMode;
  actions?: SpecDoctorAction[];
}

const BLOCKING_STATUSES = new Set<SpecDoctorIssueStatus>([
  'missing_required',
  'undeclared',
  'type_mismatch',
  'enum_mismatch',
  'pattern_mismatch',
]);

function statusLabel(status: SpecDoctorIssueStatus): string {
  return status.replace(/_/g, ' ');
}

function isBlockingStatus(status: SpecDoctorIssueStatus): boolean {
  return BLOCKING_STATUSES.has(status);
}

function isBlockingIssue(issue: SpecDoctorIssue): boolean {
  return isBlockingStatus(issue.status);
}

function isInteractiveMode(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function toPath(key: string): { namespace: string; configPath: string } {
  const separatorIndex = key.indexOf('.');

  if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
    throw new Error(`Spec key must be namespace-qualified: ${key}`);
  }

  return {
    namespace: key.slice(0, separatorIndex),
    configPath: key.slice(separatorIndex + 1),
  };
}

function toDoctorIssue(
  issue: ReturnType<typeof compareSpecToGraph>['issues'][number],
): SpecDoctorIssue {
  return {
    key: issue.key,
    status: issue.status,
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
    ...(issue.value !== undefined
      ? {
          value: issue.value,
        }
      : {}),
    ...(issue.sourceFile
      ? {
          sourceFile: issue.sourceFile,
        }
      : {}),
    ...(issue.summary
      ? {
          summary: issue.summary,
        }
      : {}),
  };
}

function renderIssueLine(issue: SpecDoctorIssue): string {
  const context = [
    issue.expectedType ? `expected=${issue.expectedType}` : undefined,
    issue.actualType ? `actual=${issue.actualType}` : undefined,
    issue.sourceFile ? `source=${issue.sourceFile}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(', ');

  return context.length > 0
    ? `- ${issue.key} [${statusLabel(issue.status)}] (${context})`
    : `- ${issue.key} [${statusLabel(issue.status)}]`;
}

function makeReportResult(
  runtime: CnosRuntime,
  mode: SpecDoctorMode,
  actions?: SpecDoctorAction[],
): SpecDoctorResult {
  const report = compareSpecToGraph(runtime);

  return {
    workspace: report.workspace,
    profile: report.profile,
    summary: report.summary,
    issues: report.issues.map((issue) => toDoctorIssue(issue)),
    mode,
    ...(actions
      ? {
          actions,
        }
      : {}),
  };
}

function getRuleForKey(runtime: CnosRuntime, logicalKey: string): ConfigSpecRule | undefined {
  return runtime.manifest.schema[logicalKey];
}

async function promptForKeyValue(
  key: string,
  rule: ConfigSpecRule | undefined,
): Promise<string> {
  const lines = [
    '',
    `Key: ${key}`,
    ...(rule?.summary ? [`Summary: ${rule.summary}`] : []),
    ...(rule?.description ? [`Description: ${rule.description}`] : []),
    ...(rule?.enum ? [`Allowed values: ${rule.enum.map((entry) => JSON.stringify(entry)).join(', ')}`] : []),
    ...(rule?.pattern ? [`Pattern: ${rule.pattern}`] : []),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  if (key.startsWith('secret.')) {
    return (await promptMaskedInput(`Enter value for ${key}: `)).trimEnd();
  }

  if (rule?.enum && rule.enum.length > 0) {
    process.stdout.write(
      `${rule.enum.map((entry, index) => `${index + 1}. ${JSON.stringify(entry)}`).join('\n')}\n`,
    );
    const choice = (await promptInput(`Choose [1-${rule.enum.length}] or enter a custom value: `)).trim();
    const index = Number(choice);

    if (Number.isFinite(index) && index >= 1 && index <= rule.enum.length) {
      return JSON.stringify(rule.enum[index - 1]);
    }

    return choice;
  }

  return (await promptInput(`Enter value for ${key}: `)).trim();
}

async function applyWriteForKey(
  key: string,
  rawValue: string,
  options: RuntimeServiceOptions,
): Promise<void> {
  const { namespace, configPath } = toPath(key);

  if (namespace === 'secret') {
    await setSecret(configPath, rawValue, options);
    return;
  }

  await defineValue(namespace, configPath, rawValue, options);
}

function hasBlockingIssues(result: SpecDoctorResult): boolean {
  return result.issues.some((issue) => isBlockingIssue(issue));
}

function hasFailedActions(actions: SpecDoctorAction[]): boolean {
  return actions.some((action) => action.result === 'failed');
}

export async function runSpecDoctor(
  mode: SpecDoctorMode,
  options: RuntimeServiceOptions = {},
): Promise<{ result: SpecDoctorResult; blocking: boolean }> {
  const runtime = await createRuntimeService({
    ...options,
    secretResolution: 'lazy',
  });

  if (mode === 'report') {
    const result = makeReportResult(runtime, mode);

    return {
      result,
      blocking: hasBlockingIssues(result),
    };
  }

  if (!isInteractiveMode()) {
    throw new Error(`spec doctor --${mode} requires an interactive TTY.`);
  }

  const report = compareSpecToGraph(runtime);
  const actions: SpecDoctorAction[] = [];
  let unresolvedBlocking = false;

  if (mode === 'fill-missing') {
    const missing = report.issues
      .filter((issue) => issue.status === 'missing_required')
      .sort((left, right) => left.key.localeCompare(right.key));

    for (const issue of missing) {
      const rule = getRuleForKey(runtime, issue.key);

      try {
        const value = await promptForKeyValue(issue.key, rule);
        await applyWriteForKey(issue.key, value, options);
        actions.push({
          key: issue.key,
          result: 'applied',
        });
      } catch (error) {
        actions.push({
          key: issue.key,
          result: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    const schemaKeys = Object.keys(runtime.manifest.schema).sort((left, right) => left.localeCompare(right));
    const issuesByKey = new Map<string, SpecDoctorIssueStatus[]>();

    for (const issue of report.issues) {
      const existing = issuesByKey.get(issue.key) ?? [];
      existing.push(issue.status);
      issuesByKey.set(issue.key, existing);
    }

    for (const key of schemaKeys) {
      const keyStatuses = issuesByKey.get(key) ?? [];
      const rule = getRuleForKey(runtime, key);
      const statusText = keyStatuses.length > 0 ? keyStatuses.map(statusLabel).join(', ') : 'ok';
      process.stdout.write(`\nKey: ${key}\nCurrent status: ${statusText}\n`);

      const actionChoice = (await promptInput('Action [k=keep, u=update, s=skip]: ')).trim().toLowerCase();

      if (actionChoice === 'k' || actionChoice === 'keep') {
        actions.push({
          key,
          result: 'skipped',
          reason: 'keep',
        });
        continue;
      }

      if (actionChoice === 's' || actionChoice === 'skip') {
        if (keyStatuses.includes('missing_required')) {
          unresolvedBlocking = true;
        }

        actions.push({
          key,
          result: 'skipped',
          reason: 'skip',
        });
        continue;
      }

      try {
        const value = await promptForKeyValue(key, rule);
        await applyWriteForKey(key, value, options);
        actions.push({
          key,
          result: 'applied',
        });
      } catch (error) {
        actions.push({
          key,
          result: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const refreshed = await createRuntimeService({
    ...options,
    secretResolution: 'lazy',
  });
  const result = makeReportResult(refreshed, mode, actions);
  const blocking =
    hasBlockingIssues(result) || hasFailedActions(actions) || unresolvedBlocking;

  return {
    result,
    blocking,
  };
}

export function formatSpecDoctorResult(result: SpecDoctorResult): string {
  const lines: string[] = [
    `Spec doctor (${result.workspace} / ${result.profile}) [mode=${result.mode}]`,
    '',
    `missingRequired=${result.summary.missingRequired}`,
    `undeclared=${result.summary.undeclared}`,
    `typeMismatch=${result.summary.typeMismatch}`,
    `enumMismatch=${result.summary.enumMismatch}`,
    `patternMismatch=${result.summary.patternMismatch}`,
    `defaultApplied=${result.summary.defaultApplied}`,
    `deprecatedInUse=${result.summary.deprecatedInUse}`,
    '',
  ];

  if (result.issues.length === 0) {
    lines.push('No spec issues detected.');
  } else {
    lines.push('Issues:');
    lines.push(...result.issues.map(renderIssueLine));
  }

  if (result.actions && result.actions.length > 0) {
    lines.push('');
    lines.push('Actions:');
    lines.push(
      ...result.actions.map((action) =>
        action.reason ? `- ${action.key}: ${action.result} (${action.reason})` : `- ${action.key}: ${action.result}`,
      ),
    );
  }

  return lines.join('\n');
}
