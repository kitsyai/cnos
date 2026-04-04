import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ValidationIssue } from '@kitsy/cnos-core';

import { createValidationSummary } from './validation.js';
import type { RuntimeServiceOptions } from './runtime.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  details: string;
}

async function checkGitignore(root: string): Promise<DoctorCheck> {
  const gitignorePath = path.join(root, '.gitignore');
  const expected = [
    '.cnos/env/.env',
    '.cnos/env/.env.*',
    '!.cnos/env/.env.example',
    '!.cnos/env/.env.*.example',
    '.cnos/workspaces/*/env/.env',
    '.cnos/workspaces/*/env/.env.*',
    '!.cnos/workspaces/*/env/.env.example',
    '!.cnos/workspaces/*/env/.env.*.example',
  ];

  try {
    const content = await readFile(gitignorePath, 'utf8');
    const missing = expected.filter((entry) => !content.includes(entry));

    return {
      name: 'gitignore',
      ok: missing.length === 0,
      details:
        missing.length === 0
          ? 'workspace secrets and live env files are ignored while example env files stay trackable'
          : `missing: ${missing.join(', ')}`,
    };
  } catch {
    return {
      name: 'gitignore',
      ok: false,
      details: 'missing .gitignore',
    };
  }
}

function issueSummary(issues: ValidationIssue[]): string {
  return issues.length === 0 ? 'no issues' : issues.map((issue) => issue.message).join('; ');
}

export async function evaluateDoctor(options: RuntimeServiceOptions = {}): Promise<DoctorCheck[]> {
  const root = path.resolve(options.root ?? process.cwd());
  const { runtime, summary } = await createValidationSummary(options);
  const localRoot = runtime.graph.workspace.workspaceRoots.find((entry) => entry.scope === 'local');
  const globalRoot = runtime.graph.workspace.workspaceRoots.find((entry) => entry.scope === 'global');

  return [
    {
      name: 'manifest',
      ok: true,
      details: `project=${runtime.manifest.project.name}`,
    },
    {
      name: 'workspace',
      ok: true,
      details: `${runtime.graph.workspace.workspaceId} via ${runtime.graph.workspace.workspaceSource}`,
    },
    {
      name: 'source-roots',
      ok: Boolean(localRoot),
      details: [localRoot?.path, globalRoot?.path].filter(Boolean).join(' | '),
    },
    {
      name: 'validation',
      ok: summary.valid,
      details: issueSummary(summary.issues),
    },
    {
      name: 'global-policy',
      ok: !runtime.manifest.workspaces.global.enabled || Boolean(runtime.graph.workspace.globalRoot),
      details: runtime.manifest.workspaces.global.enabled
        ? runtime.graph.workspace.globalRoot
          ? `enabled at ${runtime.graph.workspace.globalRoot}`
          : 'enabled but no global root resolved'
        : 'disabled',
    },
    await checkGitignore(root),
  ];
}
