import { CnosManifestError } from '../errors.js';
import { normalizeSpecRule } from '../spec/normalizeSpecRule.js';
import type {
  ManifestFile,
  NamespaceDefinition,
  NormalizedManifest,
  RuntimeNamespaceDefinition,
  VaultAuthDefinition,
  VaultDefinition,
} from '../types/manifest.js';
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
  webpack: '',
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
  process: {
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
const DEFAULT_RUNTIME_NAMESPACES: Record<string, RuntimeNamespaceDefinition> = {
  process: {
    description: 'Live process runtime values.',
    serverOnly: true,
    builtIn: true,
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
    Object.entries(namespaces ?? {})
      .filter(([namespace]) => namespace !== 'runtime')
      .map(([namespace, definition]) => [
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

function normalizeRuntimeNamespaces(
  namespaces?: ManifestFile['namespaces'],
): Record<string, RuntimeNamespaceDefinition> {
  const runtimeEntries = namespaces?.runtime ?? {};
  const normalized = Object.fromEntries(
    Object.entries(runtimeEntries).map(([namespace, definition]) => [
      namespace,
      {
        ...(definition.description?.trim()
          ? {
              description: definition.description.trim(),
            }
          : {}),
        serverOnly: definition.server_only ?? true,
      } satisfies RuntimeNamespaceDefinition,
    ]),
  );

  for (const namespace of Object.keys(normalized)) {
    if (DEFAULT_NAMESPACES[namespace] || namespace === 'runtime') {
      throw new CnosManifestError(`Runtime namespace "${namespace}" conflicts with a built-in or reserved namespace.`);
    }
  }

  return {
    ...DEFAULT_RUNTIME_NAMESPACES,
    ...normalized,
  };
}

function normalizeVaults(
  vaults?: Record<string, Partial<VaultDefinition>>,
): Record<string, VaultDefinition> {
  return Object.fromEntries(
    Object.entries(vaults ?? {}).map(([name, definition]) => {
      const legacyPassphrase = (definition as { passphrase?: unknown }).passphrase;

      if (legacyPassphrase !== undefined) {
        throw new CnosManifestError(
          `Vault "${name}" uses legacy passphrase configuration. Use vaults.${name}.auth instead.`,
        );
      }

      const provider = definition.provider?.trim();

      if (!provider) {
        throw new CnosManifestError(`Vault "${name}" requires a provider`);
      }

      const normalizedAuth = normalizeVaultAuth(name, provider, definition.auth);
      const normalizedMapping = normalizeVaultMapping(definition.mapping);
      const fallback = (definition.fallback ?? []).map((entry, index) => {
        const fallbackProvider = entry.provider?.trim();

        if (!fallbackProvider) {
          throw new CnosManifestError(`Vault "${name}" fallback ${index + 1} requires a provider`);
        }

        const fallbackMapping = normalizeVaultMapping(entry.mapping);

        return {
          provider: fallbackProvider,
          auth: normalizeVaultAuth(name, fallbackProvider, entry.auth),
          ...(Object.keys(fallbackMapping).length > 0 ? { mapping: fallbackMapping } : {}),
        };
      });

      return [
        name,
        {
          provider,
          auth: normalizedAuth,
          ...(Object.keys(normalizedMapping).length > 0
            ? {
                mapping: normalizedMapping,
              }
            : {}),
          ...(fallback.length > 0 ? { fallback } : {}),
        } satisfies VaultDefinition,
      ];
    }),
  );
}

function normalizeVaultMapping(mapping?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping ?? {})
      .filter(
        (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string',
      )
      .map(([envVar, logicalRef]) => [envVar.trim(), logicalRef.trim()] as const)
      .filter(([envVar, logicalRef]) => envVar.length > 0 && logicalRef.length > 0),
  );
}

function normalizeAuthSources(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const sources = Array.isArray((value as { from?: unknown[] }).from)
    ? (value as { from?: unknown[] }).from
    : undefined;

  const normalized = (sources ?? [])
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeVaultAuth(
  vaultName: string,
  provider: string,
  auth?: VaultAuthDefinition,
): VaultAuthDefinition {
  if (provider === 'local') {
    const passphraseSources = normalizeAuthSources(auth?.passphrase);
    const defaultToken = vaultName
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    const defaultSources = [
      ...(defaultToken ? [`env:CNOS_SECRET_PASSPHRASE_${defaultToken}`] : []),
      'env:CNOS_SECRET_PASSPHRASE',
      `keychain:cnos/${vaultName}`,
      'prompt',
    ];

    return {
      method: auth?.method ?? 'passphrase',
      passphrase: {
        from: passphraseSources ?? defaultSources,
      },
      ...(auth?.config ? { config: auth.config } : {}),
    };
  }

  if (provider === 'github-secrets' || provider === 'environment') {
    return {
      method: auth?.method ?? 'environment',
      ...(auth?.config ? { config: auth.config } : {}),
    };
  }

  return {
    ...(auth?.method ? { method: auth.method } : {}),
    ...(normalizeAuthSources(auth?.passphrase)
      ? {
          passphrase: {
            from: normalizeAuthSources(auth?.passphrase) ?? [],
          },
        }
      : {}),
    ...(normalizeAuthSources(auth?.token)
      ? {
          token: {
            from: normalizeAuthSources(auth?.token) ?? [],
          },
        }
      : {}),
    ...(auth?.config ? { config: auth.config } : {}),
  };
}

function normalizeSchema(
  schema?: ManifestFile['schema'],
): NonNullable<ManifestFile['schema']> {
  return Object.fromEntries(
    Object.entries(schema ?? {}).map(([logicalKey, rule]) => [
      logicalKey,
      normalizeSpecRule(logicalKey, rule),
    ]),
  );
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
  const runtimeNamespaces = normalizeRuntimeNamespaces(manifest.namespaces);
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
    runtimeNamespaces,
    vaults: normalizeVaults(manifest.vaults),
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
    schema: normalizeSchema(manifest.schema),
  };
}
