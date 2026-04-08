import { copyFile, readFile, writeFile } from 'node:fs/promises';

import type { EnvUsage } from './scanEnvUsage.js';
import type { EnvMappingProposal } from './proposeMapping.js';

export interface RewriteSourceResult {
  rewrittenFiles: string[];
  backupFiles: string[];
  skippedUsages: string[];
}

function importStatementFor(kind: EnvUsage['kind']): string {
  return kind === 'import-meta-env'
    ? "import cnos from '@kitsy/cnos/browser';"
    : "import cnos from '@kitsy/cnos';";
}

function replacementFor(proposal: EnvMappingProposal): string {
  if (proposal.public) {
    return `cnos.read(${JSON.stringify(`public.${proposal.logicalPath}`)})`;
  }

  return proposal.namespace === 'secret'
    ? `cnos.secret(${JSON.stringify(proposal.logicalPath)})`
    : `cnos.value(${JSON.stringify(proposal.logicalPath)})`;
}

export async function rewriteSourceFiles(
  usages: EnvUsage[],
  proposals: Map<string, EnvMappingProposal>,
): Promise<RewriteSourceResult> {
  const fileGroups = new Map<string, EnvUsage[]>();

  for (const usage of usages) {
    const existing = fileGroups.get(usage.filePath) ?? [];
    existing.push(usage);
    fileGroups.set(usage.filePath, existing);
  }

  const rewrittenFiles: string[] = [];
  const backupFiles: string[] = [];
  const skippedUsages: string[] = [];

  for (const [filePath, fileUsages] of fileGroups.entries()) {
    const original = await readFile(filePath, 'utf8');
    let nextSource = original;
    let changed = false;
    const importKinds = new Set<EnvUsage['kind']>();

    for (const usage of fileUsages) {
      const proposal = proposals.get(usage.envVar);

      if (!proposal) {
        skippedUsages.push(`${filePath}:${usage.source}`);
        continue;
      }

      if (usage.kind === 'import-meta-env' && proposal.namespace === 'secret') {
        skippedUsages.push(`${filePath}:${usage.source}`);
        continue;
      }

      const replacement = replacementFor(proposal);

      if (!nextSource.includes(usage.source)) {
        skippedUsages.push(`${filePath}:${usage.source}`);
        continue;
      }

      nextSource = nextSource.split(usage.source).join(replacement);
      changed = true;
      importKinds.add(usage.kind);
    }

    if (!changed) {
      continue;
    }

    const backupPath = `${filePath}.bak`;
    await copyFile(filePath, backupPath);
    backupFiles.push(backupPath);

    for (const kind of Array.from(importKinds)) {
      const importStatement = importStatementFor(kind);

      if (!nextSource.includes(importStatement)) {
        nextSource = `${importStatement}\n${nextSource}`;
      }
    }

    await writeFile(filePath, nextSource, 'utf8');
    rewrittenFiles.push(filePath);
  }

  return {
    rewrittenFiles: rewrittenFiles.sort((left, right) => left.localeCompare(right)),
    backupFiles: backupFiles.sort((left, right) => left.localeCompare(right)),
    skippedUsages: skippedUsages.sort((left, right) => left.localeCompare(right)),
  };
}
