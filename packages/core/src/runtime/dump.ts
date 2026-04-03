import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DumpOptions, DumpPlan, DumpPlanOptions, DumpResult, ResolvedGraph } from '../types/core.js';
import { stringifyYaml } from '../utils/yaml.js';
import { toNamespaceObject } from './projection.js';

function buildDumpFiles(graph: ResolvedGraph, options: DumpPlanOptions = {}): DumpPlan['files'] {
  const basePath = options.flatten ? '' : path.posix.join('workspaces', graph.workspace.workspaceId);
  const values = toNamespaceObject(graph, 'value');
  const secrets = toNamespaceObject(graph, 'secret');
  const files: DumpPlan['files'] = [];

  if (Object.keys(values).length > 0) {
    files.push({
      path: path.posix.join(basePath, 'values', graph.profile, 'app.yml'),
      namespace: 'value',
      content: stringifyYaml(values),
    });
  }

  if (Object.keys(secrets).length > 0) {
    files.push({
      path: path.posix.join(basePath, 'secrets', graph.profile, 'app.yml'),
      namespace: 'secret',
      content: stringifyYaml(secrets),
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function planDump(
  graph: ResolvedGraph,
  options: DumpPlanOptions = {},
): DumpPlan {
  return {
    workspaceId: graph.workspace.workspaceId,
    profile: graph.profile,
    flatten: options.flatten ?? false,
    files: buildDumpFiles(graph, options),
  };
}

export async function writeDump(
  graph: ResolvedGraph,
  options: DumpOptions,
): Promise<DumpResult> {
  const root = path.resolve(options.to);
  const plan = planDump(graph, options);

  for (const file of plan.files) {
    const destination = path.join(root, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
  }

  return {
    ...plan,
    root,
  };
}
