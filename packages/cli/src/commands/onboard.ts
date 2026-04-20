import { copyFile, mkdir, readdir, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import { loadManifest, parseYaml } from '@kitsy/cnos/internal';
import { parse as parseToml } from 'smol-toml';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { scaffoldProject } from '../services/scaffold.js';
import { defineValue } from '../services/writes.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';

const ROOT_ENV_FILE_PATTERN = /^\.env(?:\.[A-Za-z0-9_-]+)*(?:\.example)?$/;
const SECRET_LIKE_PATTERN = /(secret|token|password|passwd|private|api[_-]?key|client[_-]?secret|dsn)/i;

type SourceKind = 'env' | 'yaml' | 'json' | 'toml';

interface SourceInput {
  kind: SourceKind;
  filePath: string;
  displayName: string;
}

interface ProposedMapping {
  source: string;
  key: string;
  path: string;
  value: unknown;
  warning?: string;
}

export interface OnboardResult {
  root: string;
  workspace: string;
  mode: 'copy' | 'move';
  storageMode: 'regular' | 'workspace';
  scaffolded: string[];
  imported: string[];
  skipped: string[];
  proposed: ProposedMapping[];
  materialized: string[];
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listRootEnvFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && ROOT_ENV_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function normalizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function toLogicalPath(sourceKey: string, prefixSegments: string[]): string {
  const derivedSegments = sourceKey
    .split(/[._-]+/)
    .map((segment) => normalizePathSegment(segment))
    .filter(Boolean);

  return [...prefixSegments, ...derivedSegments].join('.');
}

function toWarning(sourceKey: string): string | undefined {
  return SECRET_LIKE_PATTERN.test(sourceKey) ? 'looks like a secret' : undefined;
}

function createProposedMapping(source: string, pathKey: string, value: unknown, warning?: string): ProposedMapping {
  return {
    source,
    key: `value.${pathKey}`,
    path: pathKey,
    value,
    ...(warning ? { warning } : {}),
  };
}

function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function flattenStructured(
  value: unknown,
  prefixSegments: string[],
  currentKey: string[] = [],
): ProposedMapping[] {
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    const pathKey = [...prefixSegments, ...currentKey.map((segment) => normalizePathSegment(segment)).filter(Boolean)].join('.');
    const sourceKey = currentKey.join('.');

    return pathKey
      ? [
          createProposedMapping(sourceKey, pathKey, value, sourceKey ? toWarning(sourceKey) : undefined),
        ]
      : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flattenStructured(nested, prefixSegments, [...currentKey, key]),
  );
}

async function parseSource(input: SourceInput, prefixSegments: string[]): Promise<ProposedMapping[]> {
  const content = await readFile(input.filePath, 'utf8');

  switch (input.kind) {
    case 'env':
      return Object.entries(parseEnv(content)).map(([sourceKey, value]) => {
        const logicalPath = toLogicalPath(sourceKey, prefixSegments);
        return createProposedMapping(sourceKey, logicalPath, value, toWarning(sourceKey));
      });
    case 'yaml':
      return flattenStructured(parseYaml<unknown>(content), prefixSegments);
    case 'json':
      return flattenStructured(JSON.parse(content) as unknown, prefixSegments);
    case 'toml':
      return flattenStructured(parseToml(content), prefixSegments);
  }
}

function detectKindFromPath(filePath: string): SourceKind {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.env':
      return 'env';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.json':
      return 'json';
    case '.toml':
      return 'toml';
    default:
      throw new Error(`Unsupported config format for ${filePath}. Use --env, --yaml, --json, --toml, or --config with a supported extension.`);
  }
}

function buildPrefixSegments(prefix: string | undefined): string[] {
  if (!prefix) {
    return [];
  }

  return prefix
    .split('.')
    .map((segment) => normalizePathSegment(segment))
    .filter(Boolean);
}

function formatProposals(proposed: ProposedMapping[]): string[] {
  if (proposed.length === 0) {
    return ['No value mappings were discovered.'];
  }

  return proposed.map((entry) => {
    const renderedValue =
      typeof entry.value === 'string' ? JSON.stringify(entry.value) : JSON.stringify(entry.value);
    return `  ${entry.source || entry.path} -> ${entry.key} = ${renderedValue}${entry.warning ? `  [${entry.warning}]` : ''}`;
  });
}

async function promptForMaterialize(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question('Materialize these values into value.*? [Y/n] ')).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function isInteractive(options: RuntimeServiceOptions): boolean {
  const processEnv = options.processEnv ?? process.env;
  return !processEnv.CI && process.stdin.isTTY && process.stdout.isTTY;
}

function resolveSourceInputs(root: string, cliArgs: string[]): SourceInput[] {
  const envFile = consumeOption(cliArgs, '--env');
  const yamlFile = consumeOption(cliArgs, '--yaml');
  const jsonFile = consumeOption(cliArgs, '--json');
  const tomlFile = consumeOption(cliArgs, '--toml');
  const configFile = consumeOption(cliArgs, '--config');
  const explicit = [
    envFile ? { kind: 'env' as const, filePath: envFile } : undefined,
    yamlFile ? { kind: 'yaml' as const, filePath: yamlFile } : undefined,
    jsonFile ? { kind: 'json' as const, filePath: jsonFile } : undefined,
    tomlFile ? { kind: 'toml' as const, filePath: tomlFile } : undefined,
    configFile ? { kind: detectKindFromPath(configFile), filePath: configFile } : undefined,
  ].filter(Boolean) as Array<{ kind: SourceKind; filePath: string }>;

  if (explicit.length > 1) {
    throw new Error('Use only one explicit source flag per onboard invocation.');
  }

  if (explicit.length === 1) {
    const source = explicit[0];

    if (!source) {
      return [];
    }

    const resolvedPath = path.resolve(root, source.filePath);
    return [
      {
        kind: source.kind,
        filePath: resolvedPath,
        displayName: path.basename(resolvedPath),
      },
    ];
  }

  return [];
}

export async function runOnboard(options: RuntimeServiceOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const cliArgs = [...(options.cliArgs ?? [])];
  const move = consumeFlag(cliArgs, '--move');
  const materialize = consumeFlag(cliArgs, '--materialize');
  const sourceOnly = consumeFlag(cliArgs, '--source-only');
  const prefix = consumeOption(cliArgs, '--prefix');

  if (materialize && sourceOnly) {
    throw new Error('Use either --materialize or --source-only, not both.');
  }

  const explicitSources = resolveSourceInputs(root, cliArgs);

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported onboard arguments: ${cliArgs.join(' ')}`);
  }

  let scaffolded: string[] = [];
  const manifestPath = path.join(root, '.cnos', 'cnos.yml');

  if (!(await exists(manifestPath))) {
    const scaffold = await scaffoldProject(root, {
      mode: options.workspace && options.workspace !== 'base' ? 'workspace' : 'regular',
      ...(options.workspace && options.workspace !== 'base' ? { workspaces: [options.workspace] } : {}),
    });
    scaffolded = scaffold.created;
  }

  const loaded = await loadManifest({
    root,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const isWorkspaceMode = Object.keys(loaded.manifest.workspaces.items).length > 0;
  const selectedWorkspace = isWorkspaceMode
    ? options.workspace ?? (loaded.manifest.workspaces.items.base ? 'base' : loaded.manifest.workspaces.default ?? 'base')
    : 'base';

  if (isWorkspaceMode && !loaded.manifest.workspaces.items[selectedWorkspace]) {
    throw new Error(`Workspace "${selectedWorkspace}" does not exist in this CNOS root.`);
  }

  if (!isWorkspaceMode && options.workspace && options.workspace !== 'base') {
    throw new Error('This repo is still in regular mode. Run `cnos workspace enable` before onboarding into a child workspace.');
  }

  const envRoot = isWorkspaceMode
    ? path.join(root, '.cnos', 'workspaces', selectedWorkspace, 'env')
    : path.join(root, '.cnos', 'env');
  await mkdir(envRoot, { recursive: true });
  const rootFiles =
    explicitSources.length > 0
      ? explicitSources
      : (await listRootEnvFiles(root)).map((fileName) => ({
          kind: 'env' as const,
          filePath: path.join(root, fileName),
          displayName: fileName,
        }));
  const imported: string[] = [];
  const skipped: string[] = [];
  const prefixSegments = buildPrefixSegments(prefix);
  const proposed: ProposedMapping[] = [];

  for (const source of rootFiles) {
    const targetPath = path.join(envRoot, source.displayName);

    try {
      await copyFile(source.filePath, targetPath);
      imported.push(path.relative(root, targetPath).replace(/\\/g, '/'));

      if (move) {
        await rm(source.filePath);
      }
    } catch {
      skipped.push(source.displayName);
      continue;
    }

    proposed.push(...(await parseSource(source, prefixSegments)));
  }

  const shouldMaterialize =
    materialize || (!sourceOnly && isInteractive(options) && proposed.length > 0 ? await promptForMaterialize() : false);
  const materialized: string[] = [];

  if (shouldMaterialize) {
    for (const entry of proposed) {
      await defineValue('value', entry.path, String(entry.value ?? ''), {
        root,
        ...(isWorkspaceMode ? { workspace: selectedWorkspace } : {}),
        parsedValue: entry.value,
      });
      materialized.push(entry.key);
    }
  }

  const result: OnboardResult = {
    root,
    workspace: selectedWorkspace,
    mode: move ? 'move' : 'copy',
    storageMode: isWorkspaceMode ? 'workspace' : 'regular',
    scaffolded,
    imported,
    skipped,
    proposed,
    materialized,
  };

  if (options.json) {
    return printJson(result);
  }

  const lines = [
    `onboarded ${selectedWorkspace} at ${root}`,
    `Imported ${imported.length} source file(s) into ${path.relative(root, envRoot).replace(/\\/g, '/') || '.cnos/env'} using ${result.mode}.`,
    '',
    `Discovered ${proposed.length} proposed value mapping(s):`,
    ...formatProposals(proposed),
  ];

  if (!shouldMaterialize && !sourceOnly && !isInteractive(options) && proposed.length > 0) {
    lines.push('', 'Non-interactive mode detected; defaulted to source-only. Re-run with --materialize to write value.* keys.');
  } else if (shouldMaterialize) {
    lines.push('', `Materialized ${materialized.length} value key(s).`);
  } else if (sourceOnly) {
    lines.push('', 'Skipped value materialization because --source-only was set.');
  }

  if (skipped.length > 0) {
    lines.push('', `Skipped ${skipped.length} source file(s): ${skipped.join(', ')}`);
  }

  return lines.join('\n');
}
