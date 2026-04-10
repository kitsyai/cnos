import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import type { LoadedManifest, LoadManifestOptions, ManifestFile } from '../types/manifest.js';
import { resolveManifestRoot } from '../utils/path.js';
import { parseYaml } from '../utils/yaml.js';
import { normalizeManifest } from './normalizeManifest.js';

export async function loadManifest(options: LoadManifestOptions = {}): Promise<LoadedManifest> {
  const resolved = await resolveManifestRoot({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const manifestRoot = resolved.manifestRoot;
  const manifestPath = path.join(manifestRoot, 'cnos.yml');
  let source: string;

  try {
    source = await readFile(manifestPath, 'utf8');
  } catch {
    throw new CnosManifestError('Unable to read CNOS manifest', manifestPath);
  }

  const rawManifest = parseYaml<ManifestFile>(source);

  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new CnosManifestError('CNOS manifest must be a YAML object', manifestPath);
  }

  return {
    manifestRoot,
    repoRoot: path.dirname(manifestRoot),
    consumerRoot: resolved.consumerRoot,
    ...(resolved.anchorPath ? { anchorPath: resolved.anchorPath } : {}),
    ...(resolved.workspace ? { anchoredWorkspace: resolved.workspace } : {}),
    manifestPath,
    manifest: normalizeManifest(rawManifest),
    rawManifest,
  };
}
