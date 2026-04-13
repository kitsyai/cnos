import { CnosDerivedExpressionError, CnosManifestError } from '../errors.js';
import type { DerivedValue, ParsedDerivation } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';

const FORBIDDEN_TARGET_NAMESPACES = new Set(['public', 'meta', 'secret']);
const FORBIDDEN_REF_NAMESPACES = new Set(['public', 'secret']);

export function validateDerivedTargetNamespace(
  manifest: NormalizedManifest,
  namespace: string,
): void {
  if (FORBIDDEN_TARGET_NAMESPACES.has(namespace)) {
    throw new CnosManifestError(`Cannot define derived values under namespace "${namespace}".`);
  }

  if (manifest.runtimeNamespaces[namespace]) {
    throw new CnosManifestError(`Cannot define derived values under runtime namespace "${namespace}".`);
  }
}

export function validateParsedDerivation(
  manifest: NormalizedManifest,
  parsed: ParsedDerivation,
): void {
  for (const ref of parsed.refs) {
    const namespace = ref.split('.')[0] ?? '';

    if (FORBIDDEN_REF_NAMESPACES.has(namespace)) {
      throw new CnosDerivedExpressionError(`Derived expressions cannot reference ${namespace}.* keys.`, parsed.raw);
    }

    if (manifest.runtimeNamespaces[namespace]) {
      continue;
    }

    if (!manifest.namespaces[namespace] && namespace !== 'value' && namespace !== 'meta') {
      throw new CnosDerivedExpressionError(`Unknown derive reference namespace: ${namespace}`, parsed.raw);
    }
  }
}

export function normalizeDerivedValue(templateOrExpr: string, expr = false): DerivedValue {
  return expr
    ? {
        $derive: {
          expr: templateOrExpr,
        },
      }
    : {
        $derive: templateOrExpr,
      };
}
