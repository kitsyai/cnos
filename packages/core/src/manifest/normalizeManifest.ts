import { CnosManifestError } from '../errors.js';
import type { ManifestFile, NormalizedManifest } from '../types/manifest.js';
import type { ProfileResolveFrom } from '../types/profile.js';

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

function validateResolveFrom(resolveFrom: ProfileResolveFrom[]): ProfileResolveFrom[] {
  const validValues: ProfileResolveFrom[] = ['cli.profile', 'env.CNOS_PROFILE', 'default'];

  for (const entry of resolveFrom) {
    if (!validValues.includes(entry)) {
      throw new CnosManifestError(`Unsupported profiles.resolveFrom entry: ${entry}`);
    }
  }

  return resolveFrom;
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

  const defaultProfile = manifest.profiles?.default?.trim() || 'local';
  const resolveFrom = validateResolveFrom(manifest.profiles?.resolveFrom ?? DEFAULT_RESOLVE_FROM);
  const filesystemValues = {
    root: './values',
    format: 'yaml',
    ...(manifest.sources?.['filesystem-values'] ?? {}),
  };
  const filesystemSecrets = {
    root: './secrets',
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
    writePolicy: {
      define: {
        defaultProfile: manifest.writePolicy?.define?.defaultProfile ?? defaultProfile,
        targets: {
          value: manifest.writePolicy?.define?.targets?.value ?? './values/{profile}/app.yml',
          secret: manifest.writePolicy?.define?.targets?.secret ?? './secrets/{profile}/app.yml',
        },
      },
    },
    schema: manifest.schema ?? {},
  };
}
