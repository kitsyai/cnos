import path from 'node:path';

import {
  applyManifestMappings,
  loadManifest,
  proposeMapping,
  rewriteSourceFiles,
  scanEnvUsage,
} from '@kitsy/cnos/internal';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { assertWritableConfigRoot } from '../services/rootAccess.js';

export async function runMigrate(options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const scan = consumeOption(cliArgs, '--scan');
  const apply = consumeFlag(cliArgs, '--apply');
  const dryRun = consumeFlag(cliArgs, '--dry-run') || !apply;
  const rewrite = consumeFlag(cliArgs, '--rewrite');

  if (cliArgs.length > 0) {
    throw new Error(`Unknown migrate options: ${cliArgs.join(' ')}`);
  }

  if (apply) {
    await assertWritableConfigRoot('apply migration mappings', options);
  }

  const manifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  const scanRoot = path.resolve(manifest.consumerRoot, scan ?? 'src');
  const usages = await scanEnvUsage(scanRoot);
  const uniqueProposals = new Map(usages.map((usage) => [usage.envVar, proposeMapping(usage.envVar)]));
  const proposals = Array.from(uniqueProposals.values()).sort((left, right) => left.envVar.localeCompare(right.envVar));

  let manifestResult:
    | {
        manifestPath: string;
        appliedMappings: number;
        appliedPromotions: number;
      }
    | undefined;
  let rewriteResult:
    | {
        rewrittenFiles: string[];
        backupFiles: string[];
        skippedUsages: string[];
      }
    | undefined;

  if (apply) {
    manifestResult = await applyManifestMappings(proposals, options.root);

    if (rewrite) {
      rewriteResult = await rewriteSourceFiles(usages.filter((usage) => usage.kind === 'process-env'), uniqueProposals);
    }
  }

  if (options.json) {
    return printJson({
      scanRoot,
      dryRun,
      apply,
      rewrite,
      usages,
      proposals,
      ...(manifestResult ? { manifest: manifestResult } : {}),
      ...(rewriteResult ? { rewriteResult } : {}),
    });
  }

  const lines = [
    `Scanned ${usages.length} env usage${usages.length === 1 ? '' : 's'} in ${scanRoot}`,
    '',
    'Proposed mappings:',
    ...proposals.map((proposal) =>
      `  ${proposal.envVar} -> ${proposal.logicalKey}${proposal.public ? ' (promote to public)' : ''}`,
    ),
  ];

  if (proposals.length === 0) {
    lines.push('  none');
  }

  if (dryRun) {
    lines.push('', 'Dry run only. Re-run with --apply to update the manifest.');
  }

  if (manifestResult) {
    lines.push(
      '',
      `Updated ${manifestResult.manifestPath} with ${manifestResult.appliedMappings} env mapping${manifestResult.appliedMappings === 1 ? '' : 's'} and ${manifestResult.appliedPromotions} public promotion${manifestResult.appliedPromotions === 1 ? '' : 's'}.`,
    );
  }

  if (rewrite) {
    if (!apply) {
      lines.push('', 'Source rewrite requested but skipped because --apply was not set.');
    } else if (rewriteResult) {
      lines.push(
        '',
        `Rewrote ${rewriteResult.rewrittenFiles.length} file${rewriteResult.rewrittenFiles.length === 1 ? '' : 's'} and created ${rewriteResult.backupFiles.length} backup${rewriteResult.backupFiles.length === 1 ? '' : 's'}.`,
      );

      if (rewriteResult.skippedUsages.length > 0) {
        lines.push('Skipped usages:');
        lines.push(...rewriteResult.skippedUsages.map((entry) => `  ${entry}`));
      }
    }
  }

  return lines.join('\n');
}
