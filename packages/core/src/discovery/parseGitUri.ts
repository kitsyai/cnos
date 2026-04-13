import { CnosDiscoveryError } from '../errors.js';

export interface ParsedGitUri {
  uri: string;
  cloneUrl: string;
  ref: string;
  subpath: string;
  transport: 'https' | 'ssh' | 'file' | 'custom';
}

export function isGitRootUri(uri: string): boolean {
  return /^git\+[a-z]+:\/\//i.test(uri);
}

export function parseGitUri(uri: string): ParsedGitUri {
  if (!isGitRootUri(uri)) {
    throw new CnosDiscoveryError(`Unsupported git root URI: ${uri}`);
  }

  const withoutPrefix = uri.slice('git+'.length);
  const hashIndex = withoutPrefix.indexOf('#');

  if (hashIndex < 0) {
    throw new CnosDiscoveryError(
      `Git root URI must include a #ref (tag, branch, or commit). Got: ${uri}`,
    );
  }

  const cloneUrl = withoutPrefix.slice(0, hashIndex);
  const fragment = withoutPrefix.slice(hashIndex + 1);
  const separatorIndex = fragment.indexOf(':');
  const ref = (separatorIndex >= 0 ? fragment.slice(0, separatorIndex) : fragment).trim();
  const subpath = (separatorIndex >= 0 ? fragment.slice(separatorIndex + 1) : '.cnos').trim() || '.cnos';
  const protocol = cloneUrl.slice(0, cloneUrl.indexOf('://'));

  if (!cloneUrl || !ref) {
    throw new CnosDiscoveryError(
      `Git root URI must include both a clone URL and #ref. Got: ${uri}`,
    );
  }

  return {
    uri,
    cloneUrl,
    ref,
    subpath,
    transport:
      protocol === 'https'
        ? 'https'
        : protocol === 'ssh'
          ? 'ssh'
          : protocol === 'file'
            ? 'file'
            : 'custom',
  };
}
