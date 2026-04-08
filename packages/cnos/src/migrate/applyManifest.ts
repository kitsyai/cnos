import { writeFile } from 'node:fs/promises';

import { loadManifest, stringifyYaml } from '@kitsy/cnos-core';

import type { EnvMappingProposal } from './proposeMapping.js';

export interface ApplyManifestResult {
  manifestPath: string;
  appliedMappings: number;
  appliedPromotions: number;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export async function applyManifestMappings(
  proposals: EnvMappingProposal[],
  root?: string,
): Promise<ApplyManifestResult> {
  const loadedManifest = await loadManifest(root ? { root } : {});
  const rawManifest = {
    ...loadedManifest.rawManifest,
  };
  const explicit = {
    ...(rawManifest.envMapping?.explicit ?? {}),
  };
  const promoted = new Set(rawManifest.public?.promote ?? []);
  let appliedMappings = 0;
  let appliedPromotions = 0;

  for (const proposal of proposals) {
    if (explicit[proposal.envVar] !== proposal.logicalKey) {
      explicit[proposal.envVar] = proposal.logicalKey;
      appliedMappings += 1;
    }

    if (proposal.public && !promoted.has(proposal.logicalKey)) {
      promoted.add(proposal.logicalKey);
      appliedPromotions += 1;
    }
  }

  rawManifest.envMapping = {
    ...(rawManifest.envMapping ?? {}),
    explicit: sortRecord(explicit),
  };

  if (promoted.size > 0) {
    rawManifest.public = {
      ...(rawManifest.public ?? {}),
      promote: Array.from(promoted).sort((left, right) => left.localeCompare(right)),
    };
  }

  await writeFile(loadedManifest.manifestPath, stringifyYaml(rawManifest), 'utf8');

  return {
    manifestPath: loadedManifest.manifestPath,
    appliedMappings,
    appliedPromotions,
  };
}
