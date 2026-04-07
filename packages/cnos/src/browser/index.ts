const SECRET_ACCESS_MESSAGE = 'CNOS: secret.* keys are not available in the browser.';

function readEmbeddedSource(): unknown {
  const globalSource = (globalThis as { __CNOS_BROWSER_DATA__?: unknown }).__CNOS_BROWSER_DATA__;

  if (globalSource !== undefined) {
    return globalSource;
  }

  if (typeof process !== 'undefined') {
    return process.env?.__CNOS_BROWSER_DATA__;
  }

  return undefined;
}

function parseBrowserData(source: unknown): Record<string, unknown> {
  if (source === undefined || source === null || source === '') {
    return {};
  }

  if (typeof source === 'string') {
    const parsed = JSON.parse(source) as unknown;
    return parseBrowserData(parsed);
  }

  if (typeof source === 'object' && !Array.isArray(source)) {
    return { ...(source as Record<string, unknown>) };
  }

  return {};
}

function normalizeBrowserKey(key: string): string {
  if (key.startsWith('secret.')) {
    throw new Error(SECRET_ACCESS_MESSAGE);
  }

  if (key.startsWith('public.')) {
    return key;
  }

  if (key.startsWith('value.')) {
    return `public.${key.slice('value.'.length)}`;
  }

  return `public.${key}`;
}

export interface BrowserCnosRuntime {
  <T = unknown>(key: string): T | undefined;
  read<T = unknown>(key: string): T | undefined;
  require<T = unknown>(key: string): T;
  toObject(): Record<string, unknown>;
}

export function read<T = unknown>(key: string): T | undefined {
  const normalized = normalizeBrowserKey(key);
  const data = parseBrowserData(readEmbeddedSource());
  return data[normalized] as T | undefined;
}

export function require<T = unknown>(key: string): T {
  const value = read<T>(key);

  if (value === undefined) {
    throw new Error(`CNOS: key "${key}" not found in browser config.`);
  }

  return value;
}

export function toObject(): Record<string, unknown> {
  return parseBrowserData(readEmbeddedSource());
}

const cnos = Object.assign(
  (<T = unknown>(key: string) => read<T>(key)) as BrowserCnosRuntime,
  {
    read,
    require,
    toObject,
  },
);

export default cnos;
