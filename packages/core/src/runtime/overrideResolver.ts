import { readFileSync } from 'node:fs';
import { parseYaml } from '../utils/yaml.js';
import type { ConfigSpecMap, ConfigSpecValueType, OverridePrioritySource, OverrideSpec } from '../types/spec.js';

const DEFAULT_PRIORITY: OverridePrioritySource[] = ['arg', 'env', 'cnos'];

/** CLI flag name that points to a bulk patch file. */
export const CNOS_PATCH_FLAG = '--cnos-patch';
/** Environment variable name that points to a bulk patch file (used when CLI args are not available). */
export const CNOS_PATCH_FILE_ENV = 'CNOS_PATCH_FILE';

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

type CoercionResult = { value: unknown; valid: boolean };

function coerceValue(raw: string, type: ConfigSpecValueType | undefined): CoercionResult {
  if (raw === '') return { value: undefined, valid: false };
  switch (type) {
    case 'number': {
      const n = Number(raw);
      if (Number.isNaN(n)) return { value: undefined, valid: false };
      return { value: n, valid: true };
    }
    case 'boolean':
      return { value: raw === 'true' || raw === '1' || raw === 'yes', valid: true };
    case 'object':
    case 'array':
      try {
        return { value: JSON.parse(raw) as unknown, valid: true };
      } catch {
        return { value: undefined, valid: false };
      }
    default:
      return { value: raw, valid: true };
  }
}

const defaultWarn = (msg: string): void => {
  process.stderr.write(msg + '\n');
};

/**
 * Applies override resolution for a single key according to its spec.
 * Warns to stderr (or the provided warn callback) and falls through to the next priority source
 * when a value is empty or cannot be coerced to the declared type.
 */
export function resolveOverride(
  spec: OverrideSpec,
  cnosValueFn: () => unknown,
  argsMap: Map<string, string>,
  env: Record<string, string | undefined>,
  key = '',
  warn: (msg: string) => void = defaultWarn,
): unknown {
  const priority = spec.priority.length > 0 ? spec.priority : DEFAULT_PRIORITY;
  const keyLabel = key ? ` for "${key}"` : '';

  for (const source of priority) {
    if (source === 'arg') {
      for (const flag of spec.arg) {
        const val = argsMap.get(flag);
        if (val === undefined) continue;
        if (val === '') {
          warn(`cnos [warn]: arg "${flag}" has empty value — skipping override${keyLabel}`);
          continue;
        }
        const { value, valid } = coerceValue(val, spec.type);
        if (!valid) {
          warn(`cnos [warn]: arg "${flag}" value "${val}" cannot be coerced to ${spec.type ?? 'string'} — skipping override${keyLabel}`);
          continue;
        }
        return value;
      }
    } else if (source === 'env') {
      for (const varName of spec.env) {
        const val = env[varName];
        if (val === undefined || val === '') continue;
        const { value, valid } = coerceValue(val, spec.type);
        if (!valid) {
          warn(`cnos [warn]: env "${varName}" value "${val}" cannot be coerced to ${spec.type ?? 'string'} — skipping override${keyLabel}`);
          continue;
        }
        return value;
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
 * Lines with an empty value (key=) are skipped with a warning.
 */
export function parsePatchProperties(
  text: string,
  warn: (msg: string) => void = defaultWarn,
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (raw === '') {
      warn(`cnos [warn]: patch file key "${key}" has empty value — skipping`);
      continue;
    }
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
 * Loads and parses a CNOS patch file.
 * Format is detected by extension: `.json`, `.yaml`/`.yml`, or anything else is treated as properties.
 * Keys must be full logical CNOS keys (e.g. `value.server.port`, `secret.db.password`).
 */
export function loadPatchFile(filePath: string): Map<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`cnos: cannot read patch file "${filePath}": ${(e as Error).message}`);
  }

  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'json') {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return new Map(Object.entries(obj));
    } catch (e) {
      throw new Error(`cnos: cannot parse JSON patch file "${filePath}": ${(e as Error).message}`);
    }
  }

  if (ext === 'yaml' || ext === 'yml') {
    try {
      const obj = parseYaml<Record<string, unknown>>(text);
      return new Map(Object.entries(obj ?? {}));
    } catch (e) {
      throw new Error(`cnos: cannot parse YAML patch file "${filePath}": ${(e as Error).message}`);
    }
  }

  return parsePatchProperties(text);
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
