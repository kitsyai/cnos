import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadManifest } from '@kitsy/cnos-core';

import { generateCodegenContent } from './generateTypes.js';

export interface WriteCodegenOutputOptions {
  root?: string;
  out?: string;
}

export interface CodegenWriteResult {
  manifestPath: string;
  typesPath: string;
  runtimePath: string;
  schemaEntryCount: number;
  hasSchema: boolean;
}

function stripTsExtension(filePath: string): string {
  return filePath.replace(/(\.d)?\.[cm]?tsx?$/i, '').replace(/\.[cm]?jsx?$/i, '');
}

export function resolveCodegenPaths(repoRoot: string, out?: string): {
  typesPath: string;
  runtimePath: string;
  typeImportPath: string;
} {
  const typesPath = out ? path.resolve(repoRoot, out) : path.join(repoRoot, '.cnos', 'types', 'cnos.d.ts');
  const runtimePath = path.join(path.dirname(typesPath), 'runtime.ts');
  const typeImportPath = `./${path.basename(stripTsExtension(typesPath))}`;

  return {
    typesPath,
    runtimePath,
    typeImportPath,
  };
}

export async function writeCodegenOutput(options: WriteCodegenOutputOptions = {}): Promise<CodegenWriteResult> {
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  const outputRoot = loadedManifest.rootResolution.remote ? loadedManifest.consumerRoot : loadedManifest.repoRoot;
  const paths = resolveCodegenPaths(outputRoot, options.out);
  const generated = generateCodegenContent(loadedManifest.manifest, loadedManifest.manifestPath, paths.typeImportPath);

  await mkdir(path.dirname(paths.typesPath), { recursive: true });
  await mkdir(path.dirname(paths.runtimePath), { recursive: true });
  await writeFile(paths.typesPath, generated.typesContent, 'utf8');
  await writeFile(paths.runtimePath, generated.runtimeContent, 'utf8');

  return {
    manifestPath: loadedManifest.manifestPath,
    typesPath: paths.typesPath,
    runtimePath: paths.runtimePath,
    schemaEntryCount: generated.schemaEntryCount,
    hasSchema: generated.hasSchema,
  };
}
