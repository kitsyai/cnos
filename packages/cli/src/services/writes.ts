import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseYaml, resolveWorkspaceScopedPath, stringifyYaml } from '@kitsy/cnos-core';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

function setNestedValue(target: Record<string, unknown>, pathSegments: string[], value: unknown): void {
  const [head, ...tail] = pathSegments;

  if (!head) {
    return;
  }

  if (tail.length === 0) {
    target[head] = value;
    return;
  }

  const nextTarget =
    target[head] && typeof target[head] === 'object' && !Array.isArray(target[head])
      ? (target[head] as Record<string, unknown>)
      : {};
  target[head] = nextTarget;
  setNestedValue(nextTarget, tail, value);
}

function parseScalarValue(rawValue: string): unknown {
  try {
    return parseYaml(rawValue);
  } catch {
    return rawValue;
  }
}

export async function defineValue(
  namespace: 'value' | 'secret',
  configPath: string,
  rawValue: string,
  options: RuntimeServiceOptions & { target?: 'local' | 'global' } = {},
): Promise<{ filePath: string; value: unknown }> {
  const runtime = await createRuntimeService(options);
  const target = options.target ?? 'local';
  const workspaceRoot = runtime.graph.workspace.workspaceRoots.find(
    (entry) => entry.scope === target && entry.workspaceId === runtime.graph.workspace.workspaceId,
  );

  if (!workspaceRoot) {
    throw new Error(`No ${target} workspace root is available for ${runtime.graph.workspace.workspaceId}`);
  }

  if (target === 'global' && !runtime.manifest.workspaces.global.allowWrite) {
    throw new Error('Global writes require workspaces.global.allowWrite: true');
  }

  const profile = options.profile ?? runtime.manifest.writePolicy.define.defaultProfile;
  const template = runtime.manifest.writePolicy.define.targets[namespace];
  const filePath = resolveWorkspaceScopedPath(workspaceRoot.path, template, {
    workspace: runtime.graph.workspace.workspaceId,
    profile,
  });
  let document: Record<string, unknown> = {};

  try {
    document = parseYaml<Record<string, unknown>>(await readFile(filePath, 'utf8')) ?? {};
  } catch {
    document = {};
  }

  const parsedValue = parseScalarValue(rawValue);
  setNestedValue(document, configPath.split('.'), parsedValue);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyYaml(document), 'utf8');

  return {
    filePath,
    value: parsedValue,
  };
}
