import type { ConfigSpecMap, ConfigSpecValueType, OverridePrioritySource, OverrideSpec } from '../types/spec.js';

const DEFAULT_PRIORITY: OverridePrioritySource[] = ['arg', 'env', 'cnos'];

/**
 * Parses a raw argv array into a flag→value map.
 *
 * Rules:
 *   --flag=value   → {--flag: value}
 *   --flag value   → {--flag: value}   (next token doesn't start with -)
 *   --flag         → {--flag: "true"}  (next token starts with - or end of args)
 *   -f value       → {-f: value}
 *   -f=value       → {-f: value}
 */
export function parseCliArgs(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) {
      i++;
      continue;
    }
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      result.set(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
      i++;
      continue;
    }
    const next = i + 1 < args.length ? args[i + 1] : undefined;
    if (next !== undefined && !next.startsWith('-')) {
      result.set(arg, next);
      i += 2;
    } else {
      result.set(arg, 'true');
      i++;
    }
  }
  return result;
}

function coerceValue(raw: string, type: ConfigSpecValueType | undefined): unknown {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case 'boolean':
      return raw === 'true' || raw === '1' || raw === 'yes';
    case 'object':
    case 'array':
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

/**
 * Applies override resolution for a single key according to its spec.
 * Returns the resolved value or undefined if nothing matched (caller falls back to CNOS value).
 */
export function resolveOverride(
  spec: OverrideSpec,
  cnosValueFn: () => unknown,
  argsMap: Map<string, string>,
  env: Record<string, string | undefined>,
): unknown {
  const priority = spec.priority.length > 0 ? spec.priority : DEFAULT_PRIORITY;

  for (const source of priority) {
    if (source === 'arg') {
      for (const flag of spec.arg) {
        const val = argsMap.get(flag);
        if (val !== undefined) return coerceValue(val, spec.type);
      }
    } else if (source === 'env') {
      for (const varName of spec.env) {
        const val = env[varName];
        if (val !== undefined && val !== '') return coerceValue(val, spec.type);
      }
    } else {
      const cnosVal = cnosValueFn();
      if (cnosVal !== undefined) return cnosVal;
    }
  }

  return cnosValueFn();
}

/** Builds the override map from the manifest schema (keyed by stripped value key). */
export function buildOverrideMap(schema: ConfigSpecMap): Map<string, OverrideSpec> {
  const map = new Map<string, OverrideSpec>();
  for (const [key, rule] of Object.entries(schema)) {
    const env = rule.env ? (Array.isArray(rule.env) ? rule.env : [rule.env]) : [];
    const arg = rule.arg ? (Array.isArray(rule.arg) ? rule.arg : [rule.arg]) : [];
    if (env.length === 0 && arg.length === 0) continue;
    const strippedKey = key.startsWith('value.') ? key.slice('value.'.length) : key;
    map.set(strippedKey, {
      env,
      arg,
      priority: rule.priority ?? DEFAULT_PRIORITY,
      ...(rule.type ? { type: rule.type } : {}),
    });
  }
  return map;
}
