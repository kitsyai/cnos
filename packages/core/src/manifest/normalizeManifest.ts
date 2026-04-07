import { CnosManifestError } from '../errors.js';
import type { ManifestFile, NamespaceDefinition, NormalizedManifest } from '../types/manifest.js';
import type { ProfileResolveFrom } from '../types/profile.js';
import type { NormalizedWorkspaceItem, WorkspaceItemConfig } from '../types/workspace.js';

const DEFAULT_RESOLVE_FROM: ProfileResolveFrom[] = ['cli.profile', 'env.CNOS_PROFILE', 'default'];
const DEFAULT_LOADERS = [
  'filesystem-values',
  'filesystem-secrets',
  'dotenv',
  'process-env',
  'cli-args',
];
const DEFAULT_VALIDATORS = ['basic-schema'];
const DEFAULT_EXPORTERS = ['env', 'public-env'];
const DEFAULT_INSPECTORS = ['provenance'];
const DEFAULT_FRAMEWORK_PREFIXES = {
  next: 'NEXT_PUBLIC_',
  vite: 'VITE_',
  nuxt: 'NUXT_PUBLIC_',
};
const DEFAULT_NAMESPACES: Record<string, NamespaceDefinition> = {
  value: {
    kind: 'data',
    shareable: true,
  },
  secret: {
    kind: 'data',
    shareable: false,
    sensitive: true,
  },
  meta: {
    kind: 'system',
    shareable: false,
    readonly: true,
  },
  public: {
    kind: 'projection',
    source: 'promote',
    shareable: true,
    readonly: true,
  },
  env: {
    kind: 'projection',
    source: 'envMapping',
    shareable: true,
    readonly: true,
  },
};

function validateResolveFrom(resolveFrom: ProfileResolveFrom[]): ProfileResolveFrom[] {
  const validValues: ProfileResolveFrom[] = ['cli.profile', 'env.CNOS_PROFILE', 'default'];

  for (const entry of resolveFrom) {
    if (!validValues.includes(entry)) {
      throw new CnosManifestError(`Unsupported profiles.resolveFrom entry: ${entry}`);
    }
  }

  return resolveFrom;
}

function normalizeWorkspaceItems(
  items?: Record<string, WorkspaceItemConfig>,
): Record<string, NormalizedWorkspaceItem> {
  return Object.fromEntries(
    Object.entries(items ?? {}).map(([workspaceId, item]: [string, WorkspaceItemConfig]) => [
      workspaceId,
      {
        extends: Array.isArray(item?.extends)
          ? item.extends.map((entry) => entry.trim()).filter(Boolean)
          : item?.extends
            ? [item.extends.trim()].filter(Boolean)
            : [],
        ...(item?.globalId?.trim() ? { globalId: item.globalId.trim() } : {}),
      } satisfies NormalizedWorkspaceItem,
    ]),
  );
}

function normalizeNamespaces(
  namespaces?: Record<string, Partial<NamespaceDefinition>>,
): Record<string, NamespaceDefinition> {
  const normalized = Object.fromEntries(
    Object.entries(namespaces ?? {}).map(([namespace, definition]) => [
      namespace,
      {
        kind: definition.kind ?? 'data',
        shareable: definition.shareable ?? false,
        ...(definition.sensitive !== undefined ? { sensitive: definition.sensitive } : {}),
        ...(definition.readonly !== undefined ? { readonly: definition.readonly } : {}),
        ...(definition.source ? { source: definition.source } : {}),
      } satisfies NamespaceDefinition,
    ]),
  );

  return {
    ...DEFAULT_NAMESPACES,
    ...normalized,
  };
}

export function normalizeManifest(manifest: ManifestFile): NormalizedManifest {
  const version = manifest.version ?? 1;

  if (version !== 1) {
    throw new CnosManifestError(`Unsupported CNOS manifest version: ${version}`);
  }

  const projectName = manifest.project?.name?.trim();

  if (!projectName) {
    throw new CnosManifestError('Manifest requires project.name');
  }

  const defaultProfile = manifest.profiles?.default?.trim() || 'base';
  const workspaceItems = normalizeWorkspaceItems(manifest.workspaces?.items);
  const resolveFrom = validateResolveFrom(manifest.profiles?.resolveFrom ?? DEFAULT_RESOLVE_FROM);
  const filesystemValues = {
    root: './',
    format: 'yaml',
    ...(manifest.sources?.['filesystem-values'] ?? {}),
  };
  const filesystemSecrets = {
    root: './',
    format: 'yaml',
    ...(manifest.sources?.['filesystem-secrets'] ?? {}),
  };
  const dotenv = {
    root: './env',
    ...(manifest.sources?.dotenv ?? {}),
  };

  return {
    version: 1,
    project: {
      name: projectName,
    },
    workspaces: {
      ...(manifest.workspaces?.default?.trim()
        ? {
            default: manifest.workspaces.default.trim(),
          }
        : {}),
      global: {
        enabled: manifest.workspaces?.global?.enabled ?? false,
        ...(manifest.workspaces?.global?.root?.trim()
          ? {
              root: manifest.workspaces.global.root.trim(),
            }
          : {}),
        allowWrite: manifest.workspaces?.global?.allowWrite ?? false,
      },
      items: workspaceItems,
    },
    profiles: {
      default: defaultProfile,
      resolveFrom,
    },
    plugins: {
      loaders: manifest.plugins?.loaders ?? DEFAULT_LOADERS,
      resolver: manifest.plugins?.resolver ?? 'profile-aware',
      validators: manifest.plugins?.validators ?? DEFAULT_VALIDATORS,
      exporters: manifest.plugins?.exporters ?? DEFAULT_EXPORTERS,
      inspectors: manifest.plugins?.inspectors ?? DEFAULT_INSPECTORS,
    },
    sources: {
      ...(manifest.sources ?? {}),
      'filesystem-values': filesystemValues,
      'filesystem-secrets': filesystemSecrets,
      dotenv,
    },
    resolution: {
      precedence: manifest.resolution?.precedence ?? [
        'filesystem-values',
        'filesystem-secrets',
        'dotenv',
        'process-env',
        'cli-args',
      ],
      arrayPolicy: manifest.resolution?.arrayPolicy ?? 'replace',
    },
    envMapping: {
      ...(manifest.envMapping?.convention
        ? {
            convention: manifest.envMapping.convention,
          }
        : {}),
      explicit: manifest.envMapping?.explicit ?? {},
    },
    public: {
      promote: manifest.public?.promote ?? [],
      frameworks: {
        ...DEFAULT_FRAMEWORK_PREFIXES,
        ...(manifest.public?.frameworks ?? {}),
      },
    },
    namespaces: normalizeNamespaces(manifest.namespaces),
    writePolicy: {
      define: {
        defaultProfile: manifest.writePolicy?.define?.defaultProfile ?? defaultProfile,
        targets: {
          value:
            manifest.writePolicy?.define?.targets?.value ??
            './values/app.yml',
          secret:
            manifest.writePolicy?.define?.targets?.secret ??
            './secrets/app.yml',
        },
      },
    },
    schema: manifest.schema ?? {},
  };
}
