import type { LogicalKey } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';

export interface EnvMappingConfig {
  convention?: NormalizedManifest['envMapping']['convention'];
  explicit?: Record<string, LogicalKey>;
}

function normalizeMappingConfig(config: EnvMappingConfig = {}): Required<EnvMappingConfig> {
  return {
    convention: config.convention,
    explicit: config.explicit ?? {},
  };
}

function toScreamingSnakeSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function toScreamingSnake(path: string): string {
  return path
    .split('.')
    .map((segment) => toScreamingSnakeSegment(segment))
    .filter(Boolean)
    .join('_');
}

function fromScreamingSnake(path: string): string {
  return path
    .split('_')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
    .join('.');
}

export function logicalKeyToEnvVar(key: LogicalKey, config: EnvMappingConfig = {}): string | undefined {
  const normalized = normalizeMappingConfig(config);
  const explicitEntry = Object.entries(normalized.explicit).find(([, logicalKey]) => logicalKey === key);

  if (explicitEntry) {
    return explicitEntry[0];
  }

  if (normalized.convention !== 'SCREAMING_SNAKE') {
    return undefined;
  }

  if (key.startsWith('value.')) {
    return toScreamingSnake(key.slice('value.'.length));
  }

  if (key.startsWith('secret.')) {
    return `SECRET_${toScreamingSnake(key.slice('secret.'.length))}`;
  }

  return undefined;
}

export function envVarToLogicalKey(envVar: string, config: EnvMappingConfig = {}): LogicalKey | undefined {
  const normalized = normalizeMappingConfig(config);
  const explicitMatch = normalized.explicit[envVar];

  if (explicitMatch) {
    return explicitMatch;
  }

  if (normalized.convention !== 'SCREAMING_SNAKE') {
    return undefined;
  }

  if (envVar.startsWith('SECRET_')) {
    const stripped = envVar.slice('SECRET_'.length);

    if (!stripped) {
      return undefined;
    }

    return `secret.${fromScreamingSnake(stripped)}`;
  }

  if (!/^[A-Z][A-Z0-9_]*$/.test(envVar)) {
    return undefined;
  }

  return `value.${fromScreamingSnake(envVar)}`;
}
