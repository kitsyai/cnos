import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface EnvUsage {
  filePath: string;
  envVar: string;
  source: string;
  kind: 'process-env' | 'import-meta-env';
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

const PROCESS_ENV_DOT = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const PROCESS_ENV_BRACKET = /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;
const IMPORT_META_ENV_DOT = /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g;
const IMPORT_META_ENV_BRACKET = /import\.meta\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const filePath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
        continue;
      }

      files.push(...(await collectFiles(filePath)));
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(filePath);
    }
  }

  return files;
}

function collectMatches(filePath: string, source: string, pattern: RegExp, kind: EnvUsage['kind']): EnvUsage[] {
  const matches: EnvUsage[] = [];

  for (const match of source.matchAll(pattern)) {
    const envVar = match[1];

    if (!envVar) {
      continue;
    }

    matches.push({
      filePath,
      envVar,
      source: match[0],
      kind,
    });
  }

  return matches;
}

export async function scanEnvUsage(scanRoot: string): Promise<EnvUsage[]> {
  const files = await collectFiles(scanRoot);
  const usages: EnvUsage[] = [];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    usages.push(...collectMatches(filePath, source, PROCESS_ENV_DOT, 'process-env'));
    usages.push(...collectMatches(filePath, source, PROCESS_ENV_BRACKET, 'process-env'));
    usages.push(...collectMatches(filePath, source, IMPORT_META_ENV_DOT, 'import-meta-env'));
    usages.push(...collectMatches(filePath, source, IMPORT_META_ENV_BRACKET, 'import-meta-env'));
  }

  return usages.sort((left, right) => {
    const byFile = left.filePath.localeCompare(right.filePath);

    if (byFile !== 0) {
      return byFile;
    }

    return left.envVar.localeCompare(right.envVar);
  });
}
