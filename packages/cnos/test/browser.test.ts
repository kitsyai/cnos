import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import cnos from '../src/browser/index.js';
import { resolveBrowserData, resolveFrameworkEnv, resolveServerProjection, toFrameworkEnv } from '../src/build/index.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  delete (globalThis as { __CNOS_BROWSER_DATA__?: unknown }).__CNOS_BROWSER_DATA__;
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-browser-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: browser-fixture',
      'public:',
      '  promote:',
      '    - value.app.apiUrl',
      '    - value.flag.auth.upi_enabled',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
      '  explicit:',
      '    APP_API_URL: value.app.apiUrl',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    ['app:', '  apiUrl: https://api.local', 'flag:', '  auth:', '    upi_enabled: true'].join('\n'),
  );
  return root;
}

async function createRuntimeDependentFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-browser-runtime-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: browser-runtime-fixture',
      'public:',
      '  promote:',
      '    - value.app.origin',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    [
      'app:',
      '  host: kitsy.local',
      '  origin:',
      '    $derive:',
      "      expr: \"concat('https://', coalesce(process.env.PUBLIC_HOST, value.app.host))\"",
    ].join('\n'),
  );
  return root;
}

async function createServerSecretRefFixtureRoot(vaultName = 'default'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-server-build-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'secrets'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: server-build-fixture',
      'vaults:',
      `  ${vaultName}:`,
      '    provider: local',
      '    auth:',
      '      passphrase:',
      '        from:',
      '          - env:CNOS_SECRET_PASSPHRASE_DEFAULT',
      '          - env:CNOS_SECRET_PASSPHRASE',
      '          - keychain:cnos/default',
      '          - prompt',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'secrets', 'app.yml'),
    ['app:', '  token:', '    provider: local', `    vault: ${vaultName}`, '    ref: app.token'].join('\n'),
  );
  return root;
}

async function createUnknownVaultSecretRefFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-server-build-unknown-vault-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'secrets'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: server-build-unknown-vault-fixture',
      'vaults:',
      '  default:',
      '    provider: local',
      '    auth:',
      '      passphrase:',
      '        from:',
      '          - env:CNOS_SECRET_PASSPHRASE',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'secrets', 'app.yml'),
    ['app:', '  token:', '    provider: local', '    vault: typoed-vault', '    ref: app.token'].join('\n'),
  );
  return root;
}

describe('@kitsy/cnos/browser', () => {
  it('reads promoted public values and supports value.* aliases', async () => {
    const root = await createFixtureRoot();
    (globalThis as { __CNOS_BROWSER_DATA__?: unknown }).__CNOS_BROWSER_DATA__ = await resolveBrowserData({ root });

    expect(cnos('public.app.apiUrl')).toBe('https://api.local');
    expect(cnos.read('value.flag.auth.upi_enabled')).toBe(true);
    expect(cnos.toObject()).toEqual({
      'public.app.apiUrl': 'https://api.local',
      'public.flag.auth.upi_enabled': true,
    });
  });

  it('throws on secret access and missing required keys', async () => {
    (globalThis as { __CNOS_BROWSER_DATA__?: unknown }).__CNOS_BROWSER_DATA__ = {
      'public.app.apiUrl': 'https://api.local',
    };

    expect(() => cnos.read('secret.app.token')).toThrow('CNOS: secret.* keys are not available in the browser.');
    expect(() => cnos.require('public.flag.auth.upi_enabled')).toThrow(
      'CNOS: key "public.flag.auth.upi_enabled" not found in browser config.',
    );
  });
});

describe('@kitsy/cnos/build', () => {
  it('returns only public.* entries', async () => {
    const root = await createFixtureRoot();

    await expect(resolveBrowserData({ root })).resolves.toEqual({
      'public.app.apiUrl': 'https://api.local',
      'public.flag.auth.upi_enabled': true,
    });
  });

  it('maps browser data into framework env shapes', async () => {
    const root = await createFixtureRoot();
    const browserData = await resolveBrowserData({ root });

    expect(toFrameworkEnv(browserData, 'generic')).toEqual({
      APP_API_URL: 'https://api.local',
      FLAG_AUTH_UPI_ENABLED: 'true',
    });
    expect(toFrameworkEnv(browserData, 'vite')).toEqual({
      VITE_APP_API_URL: 'https://api.local',
      VITE_FLAG_AUTH_UPI_ENABLED: 'true',
    });
    await expect(resolveFrameworkEnv({ root }, 'next')).resolves.toEqual({
      NEXT_PUBLIC_APP_API_URL: 'https://api.local',
      NEXT_PUBLIC_FLAG_AUTH_UPI_ENABLED: 'true',
    });
  });

  it('rejects promoted runtime-dependent values for browser/public output', async () => {
    const root = await createRuntimeDependentFixtureRoot();

    await expect(resolveBrowserData({ root })).rejects.toThrow(
      'Cannot build browser projection: public.app.origin depends on runtime namespaces process.',
    );
    await expect(resolveFrameworkEnv({ root }, 'vite')).rejects.toThrow(
      'Cannot resolve value.app.origin for public output because it depends on runtime namespace process.',
    );
  });

  it('builds server projections with local-vault secret refs without authenticating the vault by default', async () => {
    const root = await createServerSecretRefFixtureRoot();

    await expect(resolveServerProjection({ root, processEnv: {} })).resolves.toMatchObject({
      secretRefs: {
        'app.token': {
          provider: 'local',
          vault: 'default',
          ref: 'app.token',
        },
      },
    });
  });

  it('rejects server projections when secret refs point at unknown vaults', async () => {
    const root = await createUnknownVaultSecretRefFixtureRoot();

    await expect(resolveServerProjection({ root, processEnv: {} })).rejects.toThrow(
      'Unknown vault "typoed-vault" for secret ref "secret.app.token"',
    );
  });

  it('allows callers to opt back into eager secret resolution for server projections', async () => {
    const root = await createServerSecretRefFixtureRoot();

    await expect(
      resolveServerProjection({
        root,
        processEnv: {},
        secretResolution: 'eager',
      }),
    ).rejects.toThrow('Cannot authenticate to vault "default"');
  });
});
