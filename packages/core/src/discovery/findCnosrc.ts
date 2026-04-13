import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { CnosDiscoveryError, CnosManifestError } from '../errors.js';
import type { RootResolution } from '../types/manifest.js';
import { parseYaml } from '../utils/yaml.js';
import { resolveRootUri } from './resolveRoot.js';

export interface CnosRcFile {
  root: string;
  workspace?: string;
}

export interface DiscoveredCnosAnchor {
  anchorPath: string;
  consumerRoot: string;
  manifestRoot: string;
  rootResolution: RootResolution;
  workspace?: string;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function validateCnosrc(value: unknown, filePath: string): CnosRcFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CnosManifestError('.cnosrc.yml must be a YAML object', filePath);
  }

  const root = typeof (value as { root?: unknown }).root === 'string' ? (value as { root: string }).root.trim() : '';
  const workspace =
    typeof (value as { workspace?: unknown }).workspace === 'string'
      ? (value as { workspace: string }).workspace.trim()
      : undefined;

  if (!root) {
    throw new CnosManifestError('.cnosrc.yml requires root', filePath);
  }

  return {
    root,
    ...(workspace ? { workspace } : {}),
  };
}

export async function findCnosrc(startDir = process.cwd(), maxLevels = 3): Promise<string | undefined> {
  let current = path.resolve(startDir);

  for (let depth = 0; depth <= maxLevels; depth += 1) {
    const candidate = path.join(current, '.cnosrc.yml');

    if (await exists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return undefined;
}

export async function discoverCnosAnchor(
  startDir = process.cwd(),
  maxLevels = 3,
  options: {
    processEnv?: Record<string, string | undefined>;
    cacheMode?: 'runtime' | 'build' | 'dev';
    cacheTtlSeconds?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<DiscoveredCnosAnchor> {
  const anchorPath = await findCnosrc(startDir, maxLevels);

  if (!anchorPath) {
    throw new CnosDiscoveryError(
      'No .cnosrc.yml found. Run cnos init or create .cnosrc.yml in your package root.',
    );
  }

  const source = await readFile(anchorPath, 'utf8');
  const parsed = validateCnosrc(parseYaml<unknown>(source), anchorPath);
  const consumerRoot = path.dirname(anchorPath);
  const resolvedRoot = await resolveRootUri(parsed.root, consumerRoot, options);

  return {
    anchorPath,
    consumerRoot,
    manifestRoot: resolvedRoot.manifestRoot,
    rootResolution: resolvedRoot.resolution,
    ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
  };
}
