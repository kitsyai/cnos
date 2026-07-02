import { readFileSync } from 'node:fs';
import { parseYaml } from '../utils/yaml.js';
import type { ConfigSpecMap, ConfigSpecValueType, OverridePrioritySource, OverrideSpec } from '../types/spec.js';

const DEFAULT_PRIORITY: OverridePrioritySource[] = ['arg', 'env', 'cnos'];

/** CLI flag name that points to a bulk override file. */
export const CNOS_OVERRIDE_FLAG = '--cnos-override';
/** Environment variable name that points to a bulk override file (used when CLI args are not available). */
export const CNOS_OVERRIDE_FILE_ENV = 'CNOS_OVERRIDE_FILE';

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

/**
 * Parses a `.properties` / `.env` style text block into a logical-key → value map.
 * Lines starting with `#` or `;` are comments. Values are auto-coerced:
 *   `true`/`false` → boolean, bare numbers → number, everything else → string.
 */
export function parseOverrideProperties(text: string): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    result.set(key, coercePropertyValue(raw));
  }
  return result;
}

function coercePropertyValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  // Strip surrounding quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  const n = Number(raw);
  if (raw !== '' && !Number.isNaN(n)) return n;
  return raw;
}

/**
 * Loads and parses a CNOS override file.
 * Format is detected by extension: `.json`, `.yaml`/`.yml`, or anything else is treated as properties.
 * Keys must be full logical CNOS keys (e.g. `value.server.port`, `secret.db.password`).
 */
export function loadOverrideFile(filePath: string): Map<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`cnos: cannot read override file "${filePath}": ${(e as Error).message}`);
  }

  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'json') {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return new Map(Object.entries(obj));
    } catch (e) {
      throw new Error(`cnos: cannot parse JSON override file "${filePath}": ${(e as Error).message}`);
    }
  }

  if (ext === 'yaml' || ext === 'yml') {
    try {
      const obj = parseYaml<Record<string, unknown>>(text);
      return new Map(Object.entries(obj ?? {}));
    } catch (e) {
      throw new Error(`cnos: cannot parse YAML override file "${filePath}": ${(e as Error).message}`);
    }
  }

  return parseOverrideProperties(text);
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
