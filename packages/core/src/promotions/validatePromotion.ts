import { CnosManifestError, CnosSecurityError } from '../errors.js';
import type { LogicalKey } from '../types/core.js';
import type { NamespaceDefinition, NormalizedManifest } from '../types/manifest.js';
import type { ValidationIssue } from '../types/plugin.js';

export type ProjectionTarget = 'public' | 'env';
export interface ProjectionPolicyOptions {
  allowSecretForEnv?: boolean;
}

const DEFAULT_DATA_NAMESPACE: NamespaceDefinition = {
  kind: 'data',
  shareable: false,
};

export function getNamespaceNameForKey(key: LogicalKey): string {
  const [namespace] = key.split('.');

  if (!namespace || !key.includes('.')) {
    throw new CnosManifestError(`Logical key must be namespace-qualified: ${key}`);
  }

  return namespace;
}

export function getNamespaceDefinition(
  manifest: NormalizedManifest,
  namespaceOrKey: string,
): NamespaceDefinition {
  const namespace = namespaceOrKey.includes('.') ? getNamespaceNameForKey(namespaceOrKey) : namespaceOrKey;
  return manifest.namespaces[namespace] ?? DEFAULT_DATA_NAMESPACE;
}

export function ensureProjectionAllowed(
  manifest: NormalizedManifest,
  key: LogicalKey,
  target: ProjectionTarget,
  options: ProjectionPolicyOptions = {},
): void {
  const namespace = getNamespaceNameForKey(key);

  if (namespace === 'var') {
    throw new CnosSecurityError(
      `Cannot promote ${key} to ${target} because var.* runtime configuration must never reach public or browser surfaces. Remove ${key} from public.promote / env mapping.`,
    );
  }

  const definition = getNamespaceDefinition(manifest, namespace);

  if (definition.kind !== 'data') {
    throw new CnosManifestError(
      `Cannot promote ${key} to ${target} because namespace "${namespace}" is not a data namespace.`,
    );
  }

  if (definition.sensitive) {
    if (target === 'env' && namespace === 'secret' && options.allowSecretForEnv) {
      return;
    }

    throw new CnosSecurityError(
      `Cannot promote ${key} to ${target} because namespace "${namespace}" is sensitive.`,
    );
  }

  if (!definition.shareable) {
    throw new CnosSecurityError(
      `Cannot promote ${key} to ${target} because namespace "${namespace}" is not shareable.`,
    );
  }
}

export function validateProjectionIssue(
  manifest: NormalizedManifest,
  key: LogicalKey,
  target: ProjectionTarget,
): ValidationIssue | undefined {
  try {
    ensureProjectionAllowed(manifest, key, target);
    return undefined;
  } catch (error) {
    return {
      code: target === 'public' ? 'public.invalid-promotion' : 'env.invalid-mapping',
      key,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
