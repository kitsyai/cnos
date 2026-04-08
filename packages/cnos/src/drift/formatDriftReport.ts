import type { DriftIssue, DriftReport } from './compareSchemaToGraph.js';

function formatIssueList(
  title: string,
  marker: string,
  issues: DriftIssue[],
  formatter: (issue: DriftIssue) => string,
): string[] {
  if (issues.length === 0) {
    return [];
  }

  return [
    `${title}:`,
    ...issues.map((issue) => `  ${marker} ${formatter(issue)}`),
    '',
  ];
}

export function formatDriftReport(report: DriftReport): string {
  const lines = [
    `Schema vs resolved config (${report.workspace} / ${report.profile}):`,
    '',
  ];

  lines.push(
    ...formatIssueList('Missing (required, not defined)', 'x', report.missing, (issue) => issue.key),
  );
  lines.push(
    ...formatIssueList('Undeclared (defined, not in schema)', '?', report.undeclared, (issue) =>
      issue.sourceFile ? `${issue.key} (found in ${issue.sourceFile})` : issue.key,
    ),
  );
  lines.push(
    ...formatIssueList('Type mismatches', 'x', report.mismatches, (issue) => {
      const actual = issue.value === undefined ? issue.actualType : `${issue.actualType} ${JSON.stringify(issue.value)}`;
      return `${issue.key} (schema: ${issue.expectedType}, actual: ${actual})`;
    }),
  );
  lines.push(
    ...formatIssueList('Defaults applied', 'i', report.defaultsApplied, (issue) =>
      `${issue.key} (using default: ${JSON.stringify(issue.value)})`,
    ),
  );

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  if (lines.length === 2) {
    lines.push('No drift detected.');
  }

  return lines.join('\n');
}
