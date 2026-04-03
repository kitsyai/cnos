import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import type { LoadedManifest, LoadManifestOptions, ManifestFile } from '../types/manifest.js';
import { resolveCnosRoot } from '../utils/path.js';
import { parseYaml } from '../utils/yaml.js';
import { normalizeManifest } from './normalizeManifest.js';

export async function loadManifest(options: LoadManifestOptions = {}): Promise<LoadedManifest> {
  const cnosRoot = await resolveCnosRoot(options.root);
  const manifestPath = path.join(cnosRoot, 'cnos.yml');
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
    cnosRoot,
    manifestPath,
    manifest: normalizeManifest(rawManifest),
    rawManifest,
  };
}
