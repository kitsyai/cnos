import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/parseArgs.js';
import { runBuild } from '../src/commands/build.js';
import { runCache } from '../src/commands/cache.js';
import { startDevEnvLoop } from '../src/commands/dev.js';
import { runDefine } from '../src/commands/define.js';
import { runDrift } from '../src/commands/drift.js';
import { runDiff } from '../src/commands/diff.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runDump } from '../src/commands/dump.js';
import { runCodegen } from '../src/commands/codegen.js';
import { runExport } from '../src/commands/export.js';
import { runHelp } from '../src/commands/help.js';
import { runHelpAi } from '../src/commands/helpAi.js';
import { runInit } from '../src/commands/init.js';
import { runInspect } from '../src/commands/inspect.js';
import { runList } from '../src/commands/list.js';
import { runMigrate } from '../src/commands/migrate.js';
import { runNamespace } from '../src/commands/namespace.js';
import { runOnboard } from '../src/commands/onboard.js';
import { runProfile } from '../src/commands/profile.js';
import { runRead } from '../src/commands/read.js';
import { runPromote } from '../src/commands/promote.js';
import { runCommand } from '../src/commands/run.js';
import { runSecret } from '../src/commands/secret.js';
import { runUse } from '../src/commands/use.js';
import { runValidate } from '../src/commands/validate.js';
import { runVault } from '../src/commands/vault.js';
import { runVersion } from '../src/commands/version.js';
import { runValue } from '../src/commands/value.js';
import { startWatchLoop } from '../src/commands/watch.js';
import { runWorkspace } from '../src/commands/workspace.js';
import { printJson } from '../src/format/printJson.js';

const fixtureRoots: string[] = [];
const cliPackageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 50,
): Promise<void> {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function createRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'values'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'profiles', 'stage', 'values'), {
    recursive: true,
  });
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'secrets'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'profiles', 'stage', 'secrets'), {
    recursive: true,
  });
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'env'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: cli-fixture',
      'workspaces:',
      '  default: api',
      '  global:',
      '    enabled: true',
      '    allowWrite: true',
      '  items:',
      '    api: {}',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
      '  explicit:',
      '    API_URL: value.api.baseUrl',
      '    SERVER_PORT: value.server.port',
      'public:',
      '  promote:',
      '    - value.api.baseUrl',
      'namespaces:',
      '  flags:',
      '    kind: data',
      '    shareable: true',
      'schema:',
      '  value.server.port:',
      '    type: number',
      '    required: true',
      '  value.server.host:',
      '    type: string',
      '    default: localhost',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
    [
      'app:',
      '  name: cli-fixture',
      'server:',
      '  port: "8080"',
      'api:',
      '  baseUrl: https://api.local',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'profiles', 'stage', 'values', 'app.yml'),
    ['server:', '  port: "9090"', 'api:', '  baseUrl: https://api.stage'].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'app.yml'),
    ['app:', '  token: super-secret'].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'profiles', 'stage', 'secrets', 'app.yml'),
    ['app:', '  token: stage-secret'].join('\n'),
  );
  await writeFile(path.join(root, '.cnos', 'workspaces', 'api', 'env', '.env'), 'API_URL=https://api.local\n');
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'env', '.env.stage'),
    'API_URL=https://api.stage\n',
  );
  return root;
}

async function createLocalVaultRefFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-vault-ref-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'values'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'secrets'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: vault-ref-fixture',
      'workspaces:',
      '  default: api',
      '  items:',
      '    api: {}',
      'vaults:',
      '  default:',
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
    path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
    ['app:', '  name: vault-ref-fixture', 'server:', '  port: 8080'].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'app.yml'),
    [
      'app:',
      '  token:',
      '    provider: local',
      '    ref: app.token',
      '    vault: default',
    ].join('\n'),
  );
  return root;
}

async function createSecretEnvArtifactFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-secret-env-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'values'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'secrets'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: secret-env-fixture',
      'workspaces:',
      '  default: api',
      '  items:',
      '    api: {}',
      'vaults:',
      '  ci-env:',
      '    provider: environment',
      '    mapping:',
      '      APP_TOKEN: app.token',
      'envMapping:',
      '  explicit:',
      '    SERVER_PORT: value.server.port',
      '    APP_TOKEN: secret.app.token',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
    ['server:', '  port: 8080'].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'app.yml'),
    [
      'app:',
      '  token:',
      '    provider: environment',
      '    ref: app.token',
      '    vault: ci-env',
    ].join('\n'),
  );
  return root;
}

async function createRunWithLocalVaultEnvFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-run-vault-env-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'values'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'secrets'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: run-vault-env-fixture',
      'workspaces:',
      '  default: api',
      '  items:',
      '    api: {}',
      'vaults:',
      '  default:',
      '    provider: local',
      '    auth:',
      '      passphrase:',
      '        from:',
      '          - env:CNOS_SECRET_PASSPHRASE_DEFAULT',
      '          - env:CNOS_SECRET_PASSPHRASE',
      '          - keychain:cnos/default',
      '          - prompt',
      'envMapping:',
      '  explicit:',
      '    SERVER_PORT: value.server.port',
      '    APP_TOKEN: secret.app.token',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
    ['server:', '  port: 8080'].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'app.yml'),
    [
      'app:',
      '  token:',
      '    provider: local',
      '    ref: app.token',
      '    vault: default',
    ].join('\n'),
  );
  return root;
}

async function createMultilineEnvFixture(): Promise<string> {
  const root = await createRuntimeFixture();
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: cli-fixture',
      'workspaces:',
      '  default: api',
      '  global:',
      '    enabled: true',
      '    allowWrite: true',
      '  items:',
      '    api: {}',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
      '  explicit:',
      '    API_URL: value.api.baseUrl',
      '    APP_CERT: value.app.cert',
      '    SERVER_PORT: value.server.port',
      'public:',
      '  promote:',
      '    - value.api.baseUrl',
      'namespaces:',
      '  flags:',
      '    kind: data',
      '    shareable: true',
      'schema:',
      '  value.server.port:',
      '    type: number',
      '    required: true',
      '  value.server.host:',
      '    type: string',
      '    default: localhost',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
    [
      'app:',
      '  name: cli-fixture',
      '  cert: |',
      '    -----BEGIN CERT-----',
      '    line-2',
      '    -----END CERT-----',
      'server:',
      '  port: "8080"',
      'api:',
      '  baseUrl: https://api.local',
    ].join('\n'),
  );
  return root;
}

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `git exited with ${code ?? 1}`));
    });
  });
}

async function createRemoteRuntimeFixture(): Promise<{
  consumerRoot: string;
  cacheDir: string;
  rootUri: string;
}> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-remote-repo-'));
  const consumerRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-remote-consumer-'));
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-remote-cache-'));
  fixtureRoots.push(repoRoot, consumerRoot, cacheDir);
  await mkdir(path.join(repoRoot, '.cnos', 'workspaces', 'api', 'values'), { recursive: true });
  await writeFile(
    path.join(repoRoot, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: remote-cli-fixture',
      'workspaces:',
      '  default: api',
      '  items:',
      '    api: {}',
    ].join('\n'),
  );
  await writeFile(
    path.join(repoRoot, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
    ['app:', '  name: remote-cli', 'server:', '  port: 8800'].join('\n'),
  );
  await runGit(['init'], repoRoot);
  await runGit(['config', 'user.email', 'cnos@example.com'], repoRoot);
  await runGit(['config', 'user.name', 'CNOS Test'], repoRoot);
  await runGit(['add', '.'], repoRoot);
  await runGit(['commit', '-m', 'init-remote'], repoRoot);
  await runGit(['branch', '-M', 'main'], repoRoot);
  const rootUri = `git+${pathToFileURL(repoRoot).href}#main:.cnos`;
  await writeFile(
    path.join(consumerRoot, '.cnosrc.yml'),
    ['root: ' + rootUri, 'workspace: api'].join('\n'),
  );

  return {
    consumerRoot,
    cacheDir,
    rootUri,
  };
}

describe('@kitsy/cnos-cli', () => {
  it('parses workspace-aware global flags and preserves runtime cli args', () => {
    expect(
      parseArgs([
        'read',
        'value.app.name',
        '--workspace',
        'api',
        '--profile=stage',
        '--global-root',
        'C:/global',
        '--json',
        '--value.server.port=9000',
      ]),
    ).toEqual({
      command: 'read',
      args: ['value.app.name'],
      options: {
        workspace: 'api',
        profile: 'stage',
        globalRoot: 'C:/global',
        json: true,
        cliArgs: ['--value.server.port=9000'],
      },
      passthrough: [],
    });
  });

  it('parses build env and dev env command groups', () => {
    expect(parseArgs(['build', 'env', '--profile', 'stage', '--to', '.env.stage'])).toEqual({
      command: 'build',
      args: ['env'],
      options: {
        profile: 'stage',
        cliArgs: ['--to', '.env.stage'],
      },
      passthrough: [],
    });

    expect(parseArgs(['dev', 'env', '--to', '.env.local', '--', 'pnpm', 'dev'])).toEqual({
      command: 'dev',
      args: ['env'],
      options: {
        cliArgs: ['--to', '.env.local'],
      },
      passthrough: ['pnpm', 'dev'],
    });

    expect(parseArgs(['ui', '--workspace', 'api', '--port', '4400', '--api-port', '4401'])).toEqual({
      command: 'ui',
      args: [],
      options: {
        workspace: 'api',
        cliArgs: ['--port', '4400', '--api-port', '4401'],
      },
      passthrough: [],
    });
  });

  it('parses cache command groups', () => {
    expect(parseArgs(['cache', 'list'])).toEqual({
      command: 'cache',
      args: ['list'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
  });

  it('parses workspace and onboard DX flows', () => {
    expect(parseArgs(['workspace', 'add', 'insights', '--package-root', 'apps/insights', '--extends', 'base'])).toEqual({
      command: 'workspace',
      args: ['add', 'insights'],
      options: {
        cliArgs: ['--package-root', 'apps/insights', '--extends', 'base'],
      },
      passthrough: [],
    });

    expect(parseArgs(['workspace', 'enable'])).toEqual({
      command: 'workspace',
      args: ['enable'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });

    expect(parseArgs(['init', '--mode', 'workspace', '--workspaces', 'api,web'])).toEqual({
      command: 'init',
      args: [],
      options: {
        cliArgs: ['--mode', 'workspace', '--workspaces', 'api,web'],
      },
      passthrough: [],
    });

    expect(parseArgs(['onboard', '--json', 'settings.json', '--prefix', 'app', '--materialize'])).toEqual({
      command: 'onboard',
      args: [],
      options: {
        cliArgs: ['--json', 'settings.json', '--prefix', 'app', '--materialize'],
      },
      passthrough: [],
    });
  });

  it('normalizes verb-first aliases for value, secret, and profile flows', () => {
    expect(parseArgs(['set', 'value', 'app.name', 'demo'])).toEqual({
      command: 'value',
      args: ['set', 'app.name', 'demo'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['get', 'secret', 'app.token'])).toEqual({
      command: 'secret',
      args: ['get', 'app.token'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['add', 'value', 'app.name', 'demo'])).toEqual({
      command: 'value',
      args: ['set', 'app.name', 'demo'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['remove', 'secret', 'app.token'])).toEqual({
      command: 'secret',
      args: ['delete', 'app.token'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['get', 'value.app.name'])).toEqual({
      command: 'value',
      args: ['get', 'app.name'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['set', 'value.app.name', 'demo'])).toEqual({
      command: 'value',
      args: ['set', 'app.name', 'demo'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['get', 'secret.app.token'])).toEqual({
      command: 'secret',
      args: ['get', 'app.token'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['remove', 'secret.app.token'])).toEqual({
      command: 'secret',
      args: ['delete', 'app.token'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['set', 'flags.upi_enabled', 'false'])).toEqual({
      command: 'flags',
      args: ['set', 'upi_enabled', 'false'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['get', 'flags.upi_enabled'])).toEqual({
      command: 'flags',
      args: ['get', 'upi_enabled'],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['list', 'value', '--prefix', 'app.'])).toEqual({
      command: 'value',
      args: ['list'],
      options: {
        cliArgs: ['--prefix', 'app.'],
      },
      passthrough: [],
    });
    expect(parseArgs(['create', 'vault', 'github-ci', '--provider', 'github-secrets', '--no-passphrase'])).toEqual({
      command: 'vault',
      args: ['create', 'github-ci'],
      options: {
        cliArgs: ['--provider', 'github-secrets', '--no-passphrase'],
      },
      passthrough: [],
    });
    expect(parseArgs(['run', '--set', 'value.server.port=9999', '--', 'node', 'server.js'])).toEqual({
      command: 'run',
      args: [],
      options: {
        cliArgs: ['--set', 'value.server.port=9999'],
      },
      passthrough: ['node', 'server.js'],
    });
  });

  it('parses private-profile aliases on profile create', () => {
    expect(parseArgs(['create', 'profile', 'incognito', '--private'])).toEqual({
      command: 'profile',
      args: ['create', 'incognito'],
      options: {
        cliArgs: ['--private'],
      },
      passthrough: [],
    });

    expect(parseArgs(['profile', 'create', 'incognito', '--incog'])).toEqual({
      command: 'profile',
      args: ['create', 'incognito'],
      options: {
        cliArgs: ['--incog'],
      },
      passthrough: [],
    });

    expect(parseArgs(['profile', 'create', 'incognito', '--anonymous'])).toEqual({
      command: 'profile',
      args: ['create', 'incognito'],
      options: {
        cliArgs: ['--anonymous'],
      },
      passthrough: [],
    });
  });

  it('parses global --use-private option', () => {
    expect(parseArgs(['read', 'value.app.name', '--use-private'])).toEqual({
      command: 'read',
      args: ['value.app.name'],
      options: {
        usePrivate: true,
        cliArgs: [],
      },
      passthrough: [],
    });
  });

  it('parses help flags for root and command-level help', () => {
    expect(parseArgs(['--help'])).toEqual({
      command: 'help',
      args: [],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['help-ai', 'export', 'env', '--format', 'json'])).toEqual({
      command: 'help-ai',
      args: ['export', 'env'],
      options: {
        cliArgs: ['--format', 'json'],
      },
      passthrough: [],
    });
    expect(parseArgs(['export', 'env', '--help'])).toEqual({
      command: 'export',
      args: ['env'],
      options: {
        help: true,
        cliArgs: [],
      },
      passthrough: [],
    });
    expect(parseArgs(['--version'])).toEqual({
      command: 'version',
      args: [],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    });
  });

  it('scaffolds regular mode by default and workspace mode when requested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-init-'));
    fixtureRoots.push(root);

    await runInit({ root });

    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain('profiles:\n  default: local');
    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.not.toContain('workspaces:');
    await expect(readFile(path.join(root, '.cnosrc.yml'), 'utf8')).resolves.toContain('root: ./.cnos');
    await expect(readFile(path.join(root, '.cnos-workspace.yml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      '.cnos/workspaces/*/env/.env',
    );
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      '!.cnos/workspaces/*/env/.env.*.example',
    );

    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-init-workspace-'));
    fixtureRoots.push(workspaceRoot);

    await runInit({
      root: workspaceRoot,
      cliArgs: ['--mode', 'workspace', '--workspaces', 'api,web'],
    });

    await expect(readFile(path.join(workspaceRoot, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain('default: base');
    await expect(readFile(path.join(workspaceRoot, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain('profiles:\n  default: local');
    await expect(readFile(path.join(workspaceRoot, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain('api:\n      extends: [base]');
    await expect(readFile(path.join(workspaceRoot, '.cnos-workspace.yml'), 'utf8')).resolves.toContain('workspace: base');
  });

  it('formats json output', () => {
    expect(printJson({ ok: true })).toContain('"ok": true');
  });

  it('prints the CLI version', () => {
    expect(runVersion()).toBe(cliPackageVersion.version);
  });

  it('blocks remote-root writes and exposes cache listings', async () => {
    const fixture = await createRemoteRuntimeFixture();
    const processEnv = {
      ...process.env,
      CNOS_CACHE_DIR: fixture.cacheDir,
    };

    await expect(
      runValue(['set', 'app.name', 'demo'], {
        cwd: fixture.consumerRoot,
        processEnv,
      }),
    ).rejects.toThrow('remote and read-only');

    const listed = await runCache(['list'], {
      processEnv,
    });

    expect(listed).toContain(fixture.rootUri);
    expect(listed).toContain('immutable: no');
  });

  it('shows current CLI context without creating .cnos-workspace.yml', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-use-'));
    fixtureRoots.push(root);

    await expect(runUse(['show'], { root })).resolves.toBe('no CLI context configured');
    await expect(readFile(path.join(root, '.cnos-workspace.yml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('persists CLI context updates via cnos use flags and shows them afterwards', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-use-update-'));
    fixtureRoots.push(root);

    await expect(
      runUse([], {
        root,
        profile: 'stage',
      }),
    ).resolves.toBe('updated CLI context in .cnos-workspace.yml');

    await expect(readFile(path.join(root, '.cnos-workspace.yml'), 'utf8')).resolves.toContain('profile: stage');
    await expect(runUse(['show'], { root })).resolves.toContain('"profile": "stage"');
  });

  it('prints human help for the root CLI and command topics', () => {
    expect(runHelp()).toContain('Commands');
    expect(runHelp()).toContain('help-ai');
    expect(runHelp()).toContain('Framework integrations');
    expect(runHelp()).toContain('@kitsy/cnos-next');
    expect(runHelp()).toContain('codegen');
    expect(runHelp()).toContain('drift');
    expect(runHelp()).toContain('migrate');
    expect(runHelp()).toContain('watch');
    expect(runHelp()).toContain('promote');
    expect(runHelp()).toContain('vault');
    expect(runHelp()).toContain('build');
    expect(runHelp()).toContain('dev');
    expect(runHelp('define')).toContain('Usage: cnos define <value|secret> <path> <rawValue>');
    expect(runHelp('build env')).toContain('Usage: cnos build env --to <path>');
    expect(runHelp('build env')).toContain('--reveal');
    expect(runHelp('dev env')).toContain('Usage: cnos dev env --to <path>');
    expect(runHelp('ui')).toContain('Usage: cnos ui');
    expect(runHelp('ui')).toContain('--api-port <port>');
    expect(runHelp('promote')).toContain('Usage: cnos promote <key...> --to <public|env>');
    expect(runHelp('vault create')).toContain('Usage: cnos vault create <name>');
    expect(runHelp('secret set')).toContain('Usage: cnos secret set <path> [value]');
    expect(runHelp('secret set')).toContain('--stdin');
    expect(runHelp('secret set')).toContain('reference metadata only');
    expect(runHelp('value set')).toContain('Usage: cnos value set <path> <value>');
    expect(runHelp('value set')).toContain('--derive');
    expect(runHelp('value set')).toContain('--expr');
    expect(runHelp('list')).toContain('--namespace <name>');
    expect(runHelp('list')).toContain('cnos list flags');
    expect(runHelp('list')).toContain('cnos list process');
    expect(runHelp('list')).toContain('--framework <name>');
    expect(runHelp('export env')).toContain('--framework <name>');
    expect(runHelp('export env')).toContain('--to <path>');
    expect(runHelp('codegen')).toContain('Usage: cnos codegen [--out <path>] [--watch]');
    expect(runHelp('drift')).toContain('Usage: cnos drift');
    expect(runHelp('migrate')).toContain('Usage: cnos migrate');
    expect(runHelp('watch')).toContain('Usage: cnos watch [--signal]');
    expect(runHelp('init')).toContain('--mode <regular|workspace>');
    expect(runHelp('onboard')).toContain('--materialize');
    expect(runHelp('workspace')).toContain('workspace add');
    expect(runHelp('workspace')).toContain('workspace enable');
    expect(runHelp('workspace enable')).toContain('Usage: cnos workspace enable');
    expect(runHelp('workspace list')).toContain('Usage: cnos workspace list');
  });

  it('prints machine-readable help for agents', () => {
    const rootPayload = JSON.parse(runHelpAi(undefined, ['--format', 'json']));
    const commandPayload = JSON.parse(runHelpAi('export env', ['--format=json']));
    const buildPayload = JSON.parse(runHelpAi('build env', ['--format=json']));

    expect(rootPayload.cli).toBe('cnos');
    expect(rootPayload.commands.some((command: { id: string }) => command.id === 'doctor')).toBe(true);
    expect(rootPayload.integrations.some((integration: { id: string }) => integration.id === 'next')).toBe(true);
    expect(commandPayload.command.id).toBe('export env');
    expect(buildPayload.command.id).toBe('build env');
    const secretSetPayload = JSON.parse(runHelpAi('secret set', ['--format=json']));
    expect(secretSetPayload.command.id).toBe('secret set');
    expect(secretSetPayload.command.usage).toContain('cnos secret set <path> [value]');
    expect(secretSetPayload.command.description).toContain('reference metadata only');
    expect(JSON.parse(runHelpAi('value set', ['--format=json'])).command.options.some((option: { flag: string }) => option.flag === '--derive')).toBe(true);
    expect(commandPayload.command.options.some((option: { flag: string }) => option.flag === '--public')).toBe(
      true,
    );
    expect(commandPayload.integrations.some((integration: { id: string }) => integration.id === 'vite')).toBe(true);
    expect(JSON.parse(runHelpAi('workspace add', ['--format=json'])).command.id).toBe('workspace add');
    expect(JSON.parse(runHelpAi('workspace enable', ['--format=json'])).command.id).toBe('workspace enable');
  });

  it('onboards env files into regular mode storage and materializes values only when requested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-onboard-'));
    fixtureRoots.push(root);
    await writeFile(path.join(root, '.env'), 'VITE_DEPLOY_ENV=local\n');
    await writeFile(path.join(root, '.env.stage'), 'VITE_DEPLOY_ENV=stage\n');
    await writeFile(path.join(root, '.env.stage.example'), 'VITE_DEPLOY_ENV=stage\n');

    await expect(runOnboard({ root, processEnv: { ...process.env, CI: '1' } })).resolves.toContain(
      'Non-interactive mode detected; defaulted to source-only',
    );
    await expect(readFile(path.join(root, '.cnos', 'env', '.env'), 'utf8')).resolves.toContain(
      'VITE_DEPLOY_ENV=local',
    );
    await expect(readFile(path.join(root, '.cnos', 'env', '.env.stage'), 'utf8')).resolves.toContain(
      'VITE_DEPLOY_ENV=stage',
    );
    await expect(readFile(path.join(root, '.env'), 'utf8')).resolves.toContain('VITE_DEPLOY_ENV=local');
    await expect(readFile(path.join(root, '.cnos', 'values', 'vite.yml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(
      runOnboard({
        root,
        processEnv: { ...process.env, CI: '1' },
        cliArgs: ['--env', '.env', '--materialize'],
      }),
    ).resolves.toContain('Materialized 1 value key(s).');
    await expect(runRead('value.vite.deploy.env', { root })).resolves.toBe('local');
  });

  it('onboards structured config sources with prefix scoping', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-onboard-structured-'));
    fixtureRoots.push(root);
    await writeFile(
      path.join(root, 'config.yml'),
      ['host: localhost', 'port: 5432', 'creds:', '  password: secret'].join('\n'),
    );

    await expect(
      runOnboard({
        root,
        processEnv: { ...process.env, CI: '1' },
        cliArgs: ['--yaml', 'config.yml', '--prefix', 'db', '--materialize'],
      }),
    ).resolves.toContain('Materialized 3 value key(s).');

    await expect(runRead('value.db.host', { root })).resolves.toBe('localhost');
    await expect(runRead('value.db.port', { root })).resolves.toBe('5432');
    await expect(runRead('value.db.creds.password', { root })).resolves.toBe('secret');
  });

  it('generates typed config files from schema with default and custom outputs', async () => {
    const root = await createRuntimeFixture();
    const customRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-codegen-'));
    fixtureRoots.push(customRoot);

    await expect(runCodegen({ root })).resolves.toContain('generated types from 2 schema entries');
    await expect(readFile(path.join(root, '.cnos', 'types', 'cnos.d.ts'), 'utf8')).resolves.toContain(
      'export interface CnosValueConfig',
    );
    await expect(readFile(path.join(root, '.cnos', 'types', 'runtime.ts'), 'utf8')).resolves.toContain(
      'import type { TypedCnosRuntime } from "./cnos";',
    );

    await expect(
      runCodegen({
        root,
        cliArgs: ['--out', path.join('generated', 'typed-cnos.d.ts')],
      }),
    ).resolves.toContain('generated/typed-cnos.d.ts');
    await expect(readFile(path.join(root, 'generated', 'typed-cnos.d.ts'), 'utf8')).resolves.toContain(
      '"server.port": number;',
    );
    await expect(readFile(path.join(root, 'generated', 'runtime.ts'), 'utf8')).resolves.toContain(
      'import type { TypedCnosRuntime } from "./typed-cnos";',
    );
  });

  it('reads value and secret aliases from the selected workspace', async () => {
    const root = await createRuntimeFixture();

    await expect(runRead('value.app.name', { root, workspace: 'api', processEnv: {} })).resolves.toBe(
      'cli-fixture',
    );
    await expect(runValue('server.port', { root, workspace: 'api', processEnv: {} })).resolves.toBe(
      '8080',
    );
    await expect(runSecret('app.token', { root, workspace: 'api', processEnv: {} })).resolves.toBe(
      '****',
    );
  });

  it('writes and surfaces derived values across read, list, and inspect commands', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runValue(['set', 'app.origin'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--derive', '${value.api.baseUrl}/v1'],
      }),
    ).resolves.toContain('set value.app.origin');

    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'), 'utf8'),
    ).resolves.toContain('$derive: ${value.api.baseUrl}/v1');

    await expect(
      runRead('value.app.origin', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toBe('https://api.local/v1');

    await expect(
      runList(['value'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--prefix', 'value.app.origin'],
      }),
    ).resolves.toContain('value.app.origin=https://api.local/v1  (derived)');

    await expect(
      runInspect('value.app.origin', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('derivedExpression: ${value.api.baseUrl}/v1');
  });

  it('resolves vault-backed secrets through read and secret get after vault auth', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-secret-read-'));
    fixtureRoots.push(secretHome);

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await runVault(['auth', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await runSecret(['set', 'app.token', 'super-secret'], {
      root,
      workspace: 'api',
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
      cliArgs: ['--local', '--vault', 'default'],
    });

    await expect(
      runRead('secret.app.token', {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default'],
      }),
    ).resolves.toBe('****');
    await expect(
      runRead('secret.app.token', {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default', '--reveal'],
      }),
    ).resolves.toBe('super-secret');

    await expect(
      runSecret(['get', 'app.token'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default'],
      }),
    ).resolves.toBe('****');
    await expect(
      runSecret(['get', 'app.token'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default', '--reveal'],
      }),
    ).resolves.toBe('super-secret');
    await expect(
      runList(['secrets'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
      }),
    ).resolves.toContain('secret.app.token');
    await expect(
      runList(['secrets'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
      }),
    ).resolves.toContain('****');
    await expect(
      runList(['secrets'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default', '--reveal'],
      }),
    ).resolves.toContain('super-secret');
    await expect(
      runSecret(['list'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default'],
      }),
    ).resolves.toContain('secret.app.token');
    await expect(
      runSecret(['list'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default'],
      }),
    ).resolves.toContain('****');
    await expect(
      runSecret(['list'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default', '--reveal'],
      }),
    ).resolves.toContain('super-secret');
    await expect(parseArgs(['get', 'secret.app.token', '--reveal'])).toEqual({
      command: 'secret',
      args: ['get', 'app.token'],
      options: {
        cliArgs: ['--reveal'],
      },
      passthrough: [],
    });
  }, 15000);

  it('rejects secret set without a value in non-interactive mode instead of writing an empty secret', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-secret-missing-value-'));
    const secretPath = 'email.smtp_password';
    fixtureRoots.push(secretHome);

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await runVault(['auth', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await expect(
      runSecret(['set', secretPath], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--local', '--vault', 'default'],
      }),
    ).rejects.toThrow(
      'Cannot prompt for a secret value in non-interactive mode. Pass <value> explicitly or use --stdin.',
    );

    await expect(
      runSecret(['get', secretPath], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default', '--reveal'],
      }),
    ).rejects.toThrow(`Missing CNOS secret path: ${secretPath}`);
  });

  it('defaults omitted provider-backed secret set values to logical refs instead of prompting for material', async () => {
    const root = await createRuntimeFixture();
    const manifestPath = path.join(root, '.cnos', 'cnos.yml');

    await writeFile(
      manifestPath,
      `${await readFile(manifestPath, 'utf8')}\n${[
        'vaults:',
        '  media-gcp-prod:',
        '    provider: gcp-secret-manager',
        '    auth:',
        '      method: iam',
        '    mapping:',
        '      YOUTUBE_API_KEY: youtube.apiKey',
      ].join('\n')}\n`,
    );

    await expect(
      runSecret(['set', 'youtube.apiKey'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--vault', 'media-gcp-prod'],
      }),
    ).resolves.toContain('No secret material was written by CNOS');

    const secretFile = await readFile(path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'youtube.yml'), 'utf8');

    expect(secretFile).toContain('provider: gcp-secret-manager');
    expect(secretFile).toContain('ref: youtube.apiKey');
    expect(secretFile).toContain('vault: media-gcp-prod');
  });

  it('allows vault auth to reuse an existing local session key', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-vault-session-'));
    fixtureRoots.push(secretHome);

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await expect(
      runVault(['auth', 'default'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('authenticated vault "default"');

    await expect(
      runVault(['auth', 'default'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
      }),
    ).resolves.toContain('authenticated vault "default"');
  });

  it('sets and gets a local secret even when sibling refs in the same workspace are still missing', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-partial-local-secrets-'));
    fixtureRoots.push(secretHome);

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await writeFile(
      path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'subscriptions.yml'),
      [
        'subscriptions:',
        '  razorpay:',
        '    key_id:',
        '      provider: local',
        '      ref: subscriptions.razorpay.key_id',
        '      vault: default',
        '    key_secret:',
        '      provider: local',
        '      ref: subscriptions.razorpay.key_secret',
        '      vault: default',
      ].join('\n'),
    );

    await expect(
      runSecret(['set', 'subscriptions.razorpay.key_id', 'rzp_test_123'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--local', '--vault', 'default'],
      }),
    ).resolves.toContain('set secret.subscriptions.razorpay.key_id');

    await expect(
      runSecret(['get', 'subscriptions.razorpay.key_id'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--vault', 'default', '--reveal'],
      }),
    ).resolves.toBe('rzp_test_123');
  }, 15000);

  it('supports value CRUD and generic list flows without leaking ambient env into value listings', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runValue(['set', 'app.mode', 'preview'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('set value.app.mode');
    await expect(
      runValue(['list'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--prefix', 'app.'],
      }),
    ).resolves.toContain('value.app.mode=preview');
    await expect(
      runList(['value'], {
        root,
        workspace: 'api',
        processEnv: {
          APP_NAME: 'from-process-env',
        },
        cliArgs: ['--prefix', 'value.app.'],
      }),
    ).resolves.toContain('value.app.name=cli-fixture');
    await expect(
      runList(['values'], {
        root,
        workspace: 'api',
        processEnv: {
          APP_NAME: 'from-process-env',
        },
      }),
    ).resolves.toContain('value.app.name=cli-fixture');
    await expect(
      runList(['value'], {
        root,
        workspace: 'api',
        processEnv: {
          APP_NAME: 'from-process-env',
        },
      }),
    ).resolves.not.toContain('from-process-env');
    await expect(
      runList(['values'], {
        root,
        workspace: 'api',
        processEnv: {
          APP_NAME: 'from-process-env',
        },
      }),
    ).resolves.not.toContain('from-process-env');
    await expect(
      runList(['secrets'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('secret.app.token');
    await expect(
      runList(['secrets'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('****');
    await expect(
      runList(['secrets'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--reveal'],
      }),
    ).resolves.toContain('super-secret');
    await expect(
      runList(['env'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toBe(['API_URL=https://api.local', 'SERVER_PORT=8080'].join('\n'));
    await expect(
      runList(['public'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--framework', 'vite'],
      }),
    ).resolves.toBe('VITE_API_BASE_URL=https://api.local');
    await expect(
      runValue(['delete', 'app.mode'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('deleted value.app.mode');
  });

  it('lists built-in process namespace entries without mixing them into env/public exports', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runList(['process'], {
        root,
        workspace: 'api',
        processEnv: {
          PATH: 'C:/tools',
          APPDATA: 'C:/Users/test/AppData/Roaming',
        },
        cliArgs: ['--prefix', 'env.PATH'],
      }),
    ).resolves.toContain('process.env.PATH=C:/tools');
    await expect(
      runRead('process.cwd', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toBe(process.cwd());
    await expect(
      runDoctor({
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('built-ins: value, secret, meta, process, public, env');
  });

  it('promotes keys into public and env manifest surfaces', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runPromote(['value.app.name'], {
        root,
        processEnv: {},
        cliArgs: ['--to', 'public'],
      }),
    ).resolves.toContain('promoted value.app.name to public');
    await expect(
      runPromote(['value.server.port'], {
        root,
        processEnv: {},
        cliArgs: ['--to', 'env', '--as', 'PORT'],
      }),
    ).resolves.toContain('promoted value.server.port to env as PORT');

    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      '- value.app.name',
    );
    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'PORT: value.server.port',
    );
  });

  it('requires --allow-secret for secret env mappings and still forbids secret public promotion', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runPromote(['secret.app.token'], {
        root,
        processEnv: {},
        cliArgs: ['--to', 'env', '--as', 'APP_TOKEN'],
      }),
    ).rejects.toThrow('Cannot promote secret.app.token to env because namespace "secret" is sensitive.');

    await expect(
      runPromote(['secret.app.token'], {
        root,
        processEnv: {},
        cliArgs: ['--to', 'env', '--as', 'APP_TOKEN', '--allow-secret'],
      }),
    ).resolves.toContain('promoted secret.app.token to env as APP_TOKEN with secret override');

    await expect(
      runPromote(['secret.app.token'], {
        root,
        processEnv: {},
        cliArgs: ['--to', 'public', '--allow-secret'],
      }),
    ).rejects.toThrow('--allow-secret is only supported with promote --to env');
  });

  it('supports custom data namespace CRUD, public promotion, and env export', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runNamespace('flags', ['set', 'upi_enabled', 'false'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('set flags.upi_enabled');
    await expect(readFile(path.join(root, '.cnos', 'workspaces', 'api', 'flags', 'upi_enabled.yml'), 'utf8')).resolves.toContain(
      'upi_enabled: false',
    );

    await expect(
      runNamespace('flags', ['get', 'upi_enabled'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toBe('false');
    await expect(
      runList(['flags'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('flags.upi_enabled=false');

    await expect(
      runPromote(['flags.upi_enabled'], {
        root,
        processEnv: {},
        cliArgs: ['--to', 'public'],
      }),
    ).resolves.toContain('promoted flags.upi_enabled to public');
    await expect(
      runPromote(['flags.upi_enabled'], {
        root,
        processEnv: {},
        cliArgs: ['--to', 'env', '--as', 'FLAGS_UPI_ENABLED'],
      }),
    ).resolves.toContain('promoted flags.upi_enabled to env as FLAGS_UPI_ENABLED');
    await expect(
      runRead('public.flags.upi_enabled', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toBe('false');
    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('FLAGS_UPI_ENABLED=false');
    await expect(
      runNamespace('flags', ['delete', 'upi_enabled'], {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('deleted flags.upi_enabled');
  });

  it('prints inspect output in text and json modes', async () => {
    const root = await createRuntimeFixture();

    await expect(runInspect('value.server.port', { root, workspace: 'api', processEnv: {} })).resolves.toMatchInlineSnapshot(`
      "key: value.server.port
      value: 8080
      namespace: value
      profile: base (manifest-default)
      workspace: api (cli)
      workspaceChain: api
      winner: filesystem-values via @kitsy/cnos/plugins/filesystem @ api
      winnerOrigin: .cnos/workspaces/api/values/app.yml"
    `);
    await expect(
      runInspect('value.server.port', { root, workspace: 'api', processEnv: {}, json: true }),
    ).resolves.toContain('"workspace"');
  });

  it('fails clearly for missing keys', async () => {
    const root = await createRuntimeFixture();

    await expect(runRead('value.app.missing', { root, workspace: 'api', processEnv: {} })).rejects.toThrow(
      'Missing CNOS config key',
    );
    await expect(runSecret('app.missing', { root, workspace: 'api', processEnv: {} })).rejects.toThrow(
      'Missing CNOS secret path',
    );
  });

  it('defines values locally and globally using deterministic write targets', async () => {
    const root = await createRuntimeFixture();
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-global-'));
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-global-secret-home-'));
    fixtureRoots.push(globalRoot);
    fixtureRoots.push(secretHome);

    await expect(
      runDefine('value', 'server.port', '3001', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toBe('defined value.server.port in .cnos/workspaces/api/values/server.yml');
    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', 'values', 'server.yml'), 'utf8'),
    ).resolves.toContain('3001');

    await expect(
      runVault(['create', 'default'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('created vault "default"');
    await expect(
      runVault(['auth', 'default'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('authenticated vault "default"');
    await expect(
      runDefine('secret', 'app.token', 'global-secret', {
        root,
        workspace: 'api',
        globalRoot,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--target', 'global'],
      }),
    ).resolves.toContain(globalRoot.replace(/\\/g, '/'));
    await expect(
      readFile(path.join(globalRoot, 'workspaces', 'api', 'secrets', 'app.yml'), 'utf8'),
    ).resolves.toContain('provider: local');
  });

  it('prints local profile and vault paths relative to the repo root', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-relative-secrets-'));
    fixtureRoots.push(secretHome);

    await expect(
      runProfile(['create', 'stage'], {
        root,
      }),
    ).resolves.toBe('created profile stage at .cnos/profiles/stage.yml; inherits values from base by default');

    await expect(
      runVault(['create', 'local-dev'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toBe('created vault "local-dev" with provider "local" in .cnos/cnos.yml');
  });

  it('creates profiles with implicit base inheritance and optional no-inherit mode', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runProfile(['create', 'local'], {
        root,
      }),
    ).resolves.toBe('created profile local at .cnos/profiles/local.yml; inherits values from base by default');
    await expect(readFile(path.join(root, '.cnos', 'profiles', 'local.yml'), 'utf8')).resolves.toBe('name: local\n');

    await expect(
      runProfile(['create', 'isolated'], {
        root,
        cliArgs: ['--no-inherit'],
      }),
    ).resolves.toBe('created profile isolated at .cnos/profiles/isolated.yml without inheriting base');
    await expect(readFile(path.join(root, '.cnos', 'profiles', 'isolated.yml'), 'utf8')).resolves.toContain(
      'envFiles:',
    );
    await expect(readFile(path.join(root, '.cnos', 'profiles', 'isolated.yml'), 'utf8')).resolves.toContain(
      '.env.isolated',
    );
  });

  it('creates private profiles with .private activation layers and private metadata', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runProfile(['create', 'private-stage'], {
        root,
        cliArgs: ['--private'],
      }),
    ).resolves.toBe('created profile private-stage at .cnos/profiles/private-stage.yml; inherits values from base by default');
    await expect(readFile(path.join(root, '.cnos', 'profiles', 'private-stage.yml'), 'utf8')).resolves.toContain(
      'private: true',
    );
  });

  it('writes value documents under .cnos/.private when profile is marked private', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-private-write-'));
    fixtureRoots.push(secretHome);

    await runProfile(['create', 'private-stage'], {
      root,
      cliArgs: ['--private'],
    });

    await expect(
      runVault(['create', 'default'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('created vault "default"');

    await expect(
      runDefine('value', 'app.name', 'private-override', {
        root,
        workspace: 'api',
        profile: 'private-stage',
      }),
    ).resolves.toContain('.cnos/workspaces/api/.private/profiles/private-stage/values/app.yml');

    await expect(
      runSecret(['set', 'app.token', 'private-token'], {
        root,
        workspace: 'api',
        profile: 'private-stage',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--local', '--vault', 'default'],
      }),
    ).resolves.toContain('.cnos/workspaces/api/.private/profiles/private-stage/secrets/app.yml');

    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', '.private', 'profiles', 'private-stage', 'values', 'app.yml'), 'utf8'),
    ).resolves.toContain('name: private-override');

    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', '.private', 'profiles', 'private-stage', 'secrets', 'app.yml'), 'utf8'),
    ).resolves.toContain('provider: local');
  });

  it('writes single-key entries to private layers with --private on regular profiles', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runDefine('value', 'app.name', 'public-value', {
        root,
        workspace: 'api',
        profile: 'local',
      }),
    ).resolves.toContain('.cnos/workspaces/api/profiles/local/values/app.yml');

    await expect(
      runDefine('value', 'app.name', 'private-value', {
        root,
        workspace: 'api',
        profile: 'local',
        cliArgs: ['--private'],
      }),
    ).resolves.toContain('.cnos/workspaces/api/.private/profiles/local/values/app.yml');

    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'), 'utf8'),
    ).resolves.not.toContain('public-value');

    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', 'profiles', 'local', 'values', 'app.yml'), 'utf8'),
    ).resolves.toContain('public-value');
    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', '.private', 'profiles', 'local', 'values', 'app.yml'), 'utf8'),
    ).resolves.toContain('private-value');

    await expect(
      runValue(['get', 'app.name'], {
        root,
        workspace: 'api',
        profile: 'local',
      }),
    ).resolves.toBe('public-value');
    await expect(
      runValue(['get', 'app.name'], {
        root,
        workspace: 'api',
        profile: 'local',
        usePrivate: true,
      }),
    ).resolves.toBe('private-value');
  });

  it('writes secret references to private layers with --private and resolves only with --use-private', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-private-secret-'));
    fixtureRoots.push(secretHome);

    await expect(
      runVault(['create', 'default'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('created vault "default"');

    await expect(
      runSecret(['set', 'service.token', 'private-token'], {
        root,
        workspace: 'api',
        profile: 'local',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--local', '--private', '--vault', 'default'],
      }),
    ).resolves.toContain('.cnos/workspaces/api/.private/profiles/local/secrets/service.yml');

    await expect(
      readFile(
        path.join(root, '.cnos', 'workspaces', 'api', '.private', 'profiles', 'local', 'secrets', 'service.yml'),
        'utf8',
      ),
    ).resolves.toContain('provider: local');

    await expect(
      runSecret(['get', 'service.token'], {
        root,
        workspace: 'api',
        profile: 'local',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--vault', 'default'],
      }),
    ).rejects.toThrow('Missing CNOS secret path: service.token');

    await expect(
      runSecret(['get', 'service.token'], {
        root,
        workspace: 'api',
        profile: 'local',
        usePrivate: true,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--vault', 'default', '--reveal'],
      }),
    ).resolves.toBe('private-token');
  });

  it('creates vault-backed local secret refs with simple keys', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-secrets-'));
    fixtureRoots.push(secretHome);

    await expect(
      runVault(['create', 'db'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('created vault "db"');
    await expect(
      runVault(['auth', 'db'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('authenticated vault "db"');

    await expect(
      runSecret(['set', 'app.token', 'super-secret'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--local', '--vault', 'db'],
      }),
    ).resolves.toContain('vault "db"');

    await expect(readFile(path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'app.yml'), 'utf8')).resolves.toContain(
      'ref: app.token',
    );
    await expect(readFile(path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'app.yml'), 'utf8')).resolves.toContain(
      'vault: db',
    );
    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'vaults:',
    );
    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'provider: local',
    );
  });

  it('initializes local vaults during create and rejects wrong auth passphrases later', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-vault-auth-'));
    fixtureRoots.push(secretHome);

    await expect(
      runVault(['create', 'hilk'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'correct-pass',
        },
      }),
    ).resolves.toContain('created vault "hilk"');

    await expect(readFile(path.join(secretHome, 'vaults', 'hilk', 'meta.yml'), 'utf8')).resolves.toContain(
      'pbkdf2-sha512',
    );

    await expect(
      runVault(['auth', 'hilk'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'wrong-pass',
        },
      }),
    ).rejects.toThrow('Failed to decrypt CNOS local vault. Check vault authentication.');

    await expect(
      runVault(['auth', 'hilk'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'correct-pass',
        },
      }),
    ).resolves.toContain('authenticated vault "hilk"');
  });

  it('manages manifest-defined vaults and github-secrets secret flows', async () => {
    const root = await createRuntimeFixture();

    await expect(
      runVault(['create', 'github-ci'], {
        root,
        processEnv: {},
        cliArgs: ['--provider', 'github-secrets', '--no-passphrase'],
      }),
    ).resolves.toContain('created vault "github-ci"');

    await expect(
      runVault(['list'], {
        root,
        processEnv: {},
      }),
    ).resolves.toContain('github-ci provider=github-secrets auth=environment');

    await expect(
      runSecret(['set', 'db.password', 'DB_PASSWORD'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--vault', 'github-ci'],
      }),
    ).resolves.toContain('No secret material was written by CNOS');

    await expect(readFile(path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'db.yml'), 'utf8')).resolves.toContain(
      'provider: github-secrets',
    );
    await expect(readFile(path.join(root, '.cnos', 'workspaces', 'api', 'secrets', 'db.yml'), 'utf8')).resolves.toContain(
      'vault: github-ci',
    );

    await expect(
      runSecret(['get', 'db.password'], {
        root,
        workspace: 'api',
        processEnv: {
          DB_PASSWORD: 'ci-secret',
        },
        cliArgs: ['--vault', 'github-ci'],
      }),
    ).resolves.toBe('****');
    await expect(
      runSecret(['get', 'db.password'], {
        root,
        workspace: 'api',
        processEnv: {
          DB_PASSWORD: 'ci-secret',
        },
        cliArgs: ['--vault', 'github-ci', '--reveal'],
      }),
    ).resolves.toBe('ci-secret');

    await expect(
      runSecret(['list'], {
        root,
        workspace: 'api',
        processEnv: {
          DB_PASSWORD: 'ci-secret',
        },
        cliArgs: ['--vault', 'github-ci'],
      }),
    ).resolves.toContain('secret.db.password');
    await expect(
      runSecret(['list'], {
        root,
        workspace: 'api',
        processEnv: {
          DB_PASSWORD: 'ci-secret',
        },
        cliArgs: ['--vault', 'github-ci'],
      }),
    ).resolves.toContain('****');
    await expect(
      runSecret(['list'], {
        root,
        workspace: 'api',
        processEnv: {
          DB_PASSWORD: 'ci-secret',
        },
        cliArgs: ['--vault', 'github-ci', '--reveal'],
      }),
    ).resolves.toContain('ci-secret');

    await expect(
      runVault(['remove', 'github-ci'], {
        root,
        processEnv: {},
      }),
    ).resolves.toContain('removed vault "github-ci"');
  });

  it('lists local vault stores outside a CNOS project root', async () => {
    const root = await createRuntimeFixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-outside-root-'));
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-global-vault-list-'));
    fixtureRoots.push(outsideRoot);
    fixtureRoots.push(secretHome);

    await runVault(['create', 'media-vault'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await expect(
      runVault(['list'], {
        root: outsideRoot,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
      }),
    ).resolves.toContain('media-vault provider=local auth=passphrase local-store=true source=local-store');
  });

  it('exports env projections and dumps snapshot files', async () => {
    const root = await createRuntimeFixture();
    const dumpRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-dump-'));
    const exportRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-export-'));
    fixtureRoots.push(dumpRoot);
    fixtureRoots.push(exportRoot);

    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toMatchInlineSnapshot(`
      "API_URL=https://api.local
      SERVER_PORT=8080"
    `);
    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--public', '--framework', 'vite'],
      }),
    ).resolves.toMatchInlineSnapshot(`
      "VITE_API_BASE_URL=https://api.local"
    `);
    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        processEnv: {
          APPDATA: 'ambient',
        },
        cliArgs: ['--to', path.join(exportRoot, '.env.local')],
      }),
    ).resolves.toContain('.env.local');
    await expect(readFile(path.join(exportRoot, '.env.local'), 'utf8')).resolves.toBe(
      ['API_URL=https://api.local', 'SERVER_PORT=8080'].join('\n'),
    );
    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--to', path.join(exportRoot, '.env.built')],
      }),
    ).resolves.toContain('.env.built');
    await expect(readFile(path.join(exportRoot, '.env.built'), 'utf8')).resolves.toBe(
      ['API_URL=https://api.local', 'SERVER_PORT=8080'].join('\n'),
    );
    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        profile: 'stage',
        processEnv: {
          APPDATA: 'ambient',
        },
        cliArgs: ['--to', path.join(exportRoot, '.env.stage')],
      }),
    ).resolves.toContain('.env.stage');
    await expect(readFile(path.join(exportRoot, '.env.stage'), 'utf8')).resolves.toBe(
      ['API_URL=https://api.stage', 'SERVER_PORT=9090'].join('\n'),
    );
    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--public', '--framework', 'vite', '--to', path.join(exportRoot, '.env.vite')],
      }),
    ).resolves.toContain('.env.vite');
    await expect(readFile(path.join(exportRoot, '.env.vite'), 'utf8')).resolves.toBe(
      'VITE_API_BASE_URL=https://api.local',
    );
    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        profile: 'stage',
        processEnv: {},
        cliArgs: ['--public', '--framework', 'next', '--to', path.join(exportRoot, '.env.next')],
      }),
    ).resolves.toContain('.env.next');
    await expect(readFile(path.join(exportRoot, '.env.next'), 'utf8')).resolves.toBe(
      'NEXT_PUBLIC_API_BASE_URL=https://api.stage',
    );
    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).rejects.toThrow('build env requires --to <path>');
    await expect(
      runBuild('server', {
        root,
        workspace: 'api',
        processEnv: {
          APP_NAME: 'from-process-env',
          PATH: 'C:/tools',
        },
        cliArgs: ['--to', path.join(exportRoot, '.cnos-server.json')],
      }),
    ).resolves.toContain('.cnos-server.json');
    await expect(readFile(path.join(exportRoot, '.cnos-server.json'), 'utf8')).resolves.toContain('"workspace": "api"');
    await expect(readFile(path.join(exportRoot, '.cnos-server.json'), 'utf8')).resolves.not.toContain('from-process-env');
    await expect(readFile(path.join(exportRoot, '.cnos-server.json'), 'utf8')).resolves.not.toContain('C:/tools');
    await expect(
      runBuild('public', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--framework', 'vite', '--to', path.join(exportRoot, '.env.public')],
      }),
    ).resolves.toContain('.env.public');
    await expect(readFile(path.join(exportRoot, '.env.public'), 'utf8')).resolves.toBe(
      'VITE_API_BASE_URL=https://api.local',
    );
    await expect(
      runDump({
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--flatten', '--to', dumpRoot],
      }),
    ).resolves.toContain(dumpRoot);
    await expect(readFile(path.join(dumpRoot, 'values', 'base', 'app.yml'), 'utf8')).resolves.toContain(
      'baseUrl: https://api.local',
    );
  });

  it('serializes multiline env values safely across export and build env formats', async () => {
    const root = await createMultilineEnvFixture();
    const exportRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-multiline-export-'));
    fixtureRoots.push(exportRoot);

    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('APP_CERT="-----BEGIN CERT-----\\nline-2\\n-----END CERT-----\\n"');

    const dotenvTarget = path.join(exportRoot, '.env.multi');
    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--to', dotenvTarget],
      }),
    ).resolves.toContain('.env.multi');
    await expect(readFile(dotenvTarget, 'utf8')).resolves.toContain(
      'APP_CERT="-----BEGIN CERT-----\\nline-2\\n-----END CERT-----\\n"',
    );

    const shellTarget = path.join(exportRoot, '.env.shell');
    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--format', 'shell', '--to', shellTarget],
      }),
    ).resolves.toContain('.env.shell');
    await expect(readFile(shellTarget, 'utf8')).resolves.toContain(
      "export APP_CERT='-----BEGIN CERT-----\nline-2\n-----END CERT-----\n'",
    );

    const tomlTarget = path.join(exportRoot, '.env.toml');
    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--format', 'toml', '--to', tomlTarget],
      }),
    ).resolves.toContain('.env.toml');
    await expect(readFile(tomlTarget, 'utf8')).resolves.toContain(
      'APP_CERT = "-----BEGIN CERT-----\\nline-2\\n-----END CERT-----\\n"',
    );
  });

  it('keeps secret env mappings masked by default and reveals them only for gitignored targets', async () => {
    const root = await createSecretEnvArtifactFixture();
    const maskedTarget = path.join(root, '.env.masked');
    const revealedTarget = path.join(root, '.env.revealed');

    await runGit(['init'], root);
    await writeFile(path.join(root, '.gitignore'), ['.env.masked', '.env.revealed'].join('\n'));

    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {
          APP_TOKEN: 'ci-secret',
        },
        cliArgs: ['--to', maskedTarget],
      }),
    ).resolves.toContain('.env.masked');
    await expect(readFile(maskedTarget, 'utf8')).resolves.toBe(['APP_TOKEN=****', 'SERVER_PORT=8080'].join('\n'));

    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {
          APP_TOKEN: 'ci-secret',
        },
        cliArgs: ['--to', revealedTarget, '--reveal'],
      }),
    ).resolves.toContain('.env.revealed');
    await expect(readFile(revealedTarget, 'utf8')).resolves.toBe(
      ['APP_TOKEN=ci-secret', 'SERVER_PORT=8080'].join('\n'),
    );
  });

  it('reveals local-vault secret env mappings in env artifacts once mapped secrets are hydrated', async () => {
    const root = await createRunWithLocalVaultEnvFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-build-vault-session-'));
    const revealedTarget = path.join(root, '.env.revealed');
    fixtureRoots.push(secretHome);

    await runGit(['init'], root);
    await writeFile(path.join(root, '.gitignore'), '.env.revealed\n');

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await runSecret(['set', 'app.token', 'super-secret'], {
      root,
      workspace: 'api',
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
      cliArgs: ['--local', '--vault', 'default'],
    });

    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--to', revealedTarget, '--reveal'],
      }),
    ).resolves.toContain('.env.revealed');

    await expect(readFile(revealedTarget, 'utf8')).resolves.toBe(
      ['APP_TOKEN=super-secret', 'SERVER_PORT=8080'].join('\n'),
    );
  });

  it('refuses to write revealed secret env artifacts when the target is not gitignored', async () => {
    const root = await createSecretEnvArtifactFixture();
    const target = path.join(root, '.env.not-ignored');

    await runGit(['init'], root);
    await writeFile(path.join(root, '.gitignore'), '.env.safe-only\n');

    await expect(
      runBuild('env', {
        root,
        workspace: 'api',
        processEnv: {
          APP_TOKEN: 'ci-secret',
        },
        cliArgs: ['--to', target, '--reveal'],
      }),
    ).rejects.toThrow('is not gitignored');
  });

  it('builds server projections with local-vault secret refs without authenticating the vault', async () => {
    const root = await createLocalVaultRefFixture();
    const exportRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-server-projection-'));
    fixtureRoots.push(exportRoot);

    await expect(
      runBuild('server', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--to', path.join(exportRoot, '.cnos-server.json')],
      }),
    ).resolves.toContain('.cnos-server.json');

    await expect(readFile(path.join(exportRoot, '.cnos-server.json'), 'utf8')).resolves.toContain(
      '"app.token"',
    );
    await expect(readFile(path.join(exportRoot, '.cnos-server.json'), 'utf8')).resolves.toContain(
      '"provider": "local"',
    );
    await expect(readFile(path.join(exportRoot, '.cnos-server.json'), 'utf8')).resolves.toContain(
      '"vault": "default"',
    );
  });

  it('runs child processes with injected env and returns diffs between profiles', async () => {
    const root = await createRuntimeFixture();
    const result = await runCommand(
      [
        process.execPath,
        '-e',
        "process.stdout.write(`${process.env.API_URL}|${process.env.SERVER_PORT}`)",
      ],
      {
        root,
        workspace: 'api',
        processEnv: {},
        stdio: 'pipe',
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('https://api.local|8080');
    const overrideResult = await runCommand(
      [
        process.execPath,
        '-e',
        "process.stdout.write(`${process.env.API_URL}|${process.env.SERVER_PORT}|${process.env.__CNOS_GRAPH__ ? 'yes' : 'no'}`)",
      ],
      {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--set', 'value.server.port=9999'],
        stdio: 'pipe',
      },
    );

    expect(overrideResult.exitCode).toBe(0);
    expect(overrideResult.stdout).toBe('https://api.local|9999|yes');
    const publicResult = await runCommand(
      [
        process.execPath,
        '-e',
        "process.stdout.write(`${process.env.NEXT_PUBLIC_API_BASE_URL}|${String(process.env.SERVER_PORT)}|${process.env.__CNOS_GRAPH__ ? 'yes' : 'no'}`)",
      ],
      {
        root,
        workspace: 'api',
        profile: 'stage',
        processEnv: {},
        cliArgs: ['--public', '--framework', 'next'],
        stdio: 'pipe',
      },
    );

    expect(publicResult.exitCode).toBe(0);
    expect(publicResult.stdout).toBe('https://api.stage|undefined|yes');
    await expect(runDiff('base', 'stage', { root, workspace: 'api', processEnv: {} })).resolves.toContain(
      'value.server.port: 8080 -> 9090',
    );
  });

  it('runs bare node commands on Windows-safe quoting and injects secret env mappings into private child envs', async () => {
    const root = await createRunWithLocalVaultEnvFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-run-vault-session-'));
    fixtureRoots.push(secretHome);

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await runSecret(['set', 'app.token', 'super-secret'], {
      root,
      workspace: 'api',
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
      cliArgs: ['--local', '--vault', 'default'],
    });

    await expect(
      runVault(['auth', 'default'], {
        root,
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
      }),
    ).resolves.toContain('authenticated vault "default"');

    const result = await runCommand(
      [
        'node',
        '-e',
        "process.stdout.write(Object.keys(process.env).filter((key) => /^(APP_TOKEN|SERVER_PORT)$/.test(key)).sort().map((key) => `${key}=${process.env[key]}`).join('\\n'))",
      ],
      {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        stdio: 'pipe',
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('APP_TOKEN=super-secret\nSERVER_PORT=8080');
  });

  it('lists env projections with secret mappings masked by default and revealed on demand', async () => {
    const root = await createRunWithLocalVaultEnvFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-list-vault-session-'));
    fixtureRoots.push(secretHome);

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
    });

    await runSecret(['set', 'app.token', 'super-secret'], {
      root,
      workspace: 'api',
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
        CNOS_SECRET_PASSPHRASE: 'dev-pass',
      },
      cliArgs: ['--local', '--vault', 'default'],
    });

    await expect(
      runList(['env'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
      }),
    ).resolves.toContain('APP_TOKEN=****');

    await expect(
      runList(['env'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--reveal'],
      }),
    ).resolves.toContain('APP_TOKEN=super-secret');
  });

  it('detaches and reattaches a workspace through .cnosrc.yml anchors', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-workspace-'));
    fixtureRoots.push(repoRoot);
    await mkdir(path.join(repoRoot, '.cnos', 'workspaces', 'travel', 'values'), { recursive: true });
    await mkdir(path.join(repoRoot, 'apps', 'travel'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: monorepo-fixture',
        'workspaces:',
        '  default: travel',
        '  items:',
        '    travel: {}',
      ].join('\n'),
    );
    await writeFile(
      path.join(repoRoot, '.cnos', 'workspaces', 'travel', 'values', 'app.yml'),
      ['app:', '  name: Travel'].join('\n'),
    );
    await writeFile(
      path.join(repoRoot, 'apps', 'travel', '.cnosrc.yml'),
      'root: ../../.cnos\nworkspace: travel\n',
    );

    await expect(
      runWorkspace(['detach'], {
        cliArgs: ['--package-root', path.join(repoRoot, 'apps', 'travel')],
      }),
    ).resolves.toContain('detached workspace travel');
    await expect(readFile(path.join(repoRoot, 'apps', 'travel', '.cnosrc.yml'), 'utf8')).resolves.toContain(
      'root: ./.cnos',
    );
    await expect(readFile(path.join(repoRoot, 'apps', 'travel', '.cnos', '.detached'), 'utf8')).resolves.toContain(
      'detachedWorkspace: travel',
    );

    await expect(
      runWorkspace(['attach'], {
        cliArgs: ['--package-root', path.join(repoRoot, 'apps', 'travel'), '--force'],
      }),
    ).resolves.toContain('attached workspace travel');
    await expect(readFile(path.join(repoRoot, 'apps', 'travel', '.cnosrc.yml'), 'utf8')).resolves.toContain(
      'workspace: travel',
    );
    await expect(
      readFile(path.join(repoRoot, '.cnos', 'workspaces', 'travel', 'values', 'app.yml'), 'utf8'),
    ).resolves.toContain('Travel');
  });

  it('enables workspace mode and manages child workspaces through the workspace command family', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-workspace-add-'));
    fixtureRoots.push(repoRoot);
    await mkdir(path.join(repoRoot, 'apps', 'insights'), { recursive: true });
    await mkdir(path.join(repoRoot, '.cnos', 'values'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.gitignore'),
      'node_modules/\n',
    );
    await writeFile(
      path.join(repoRoot, '.cnosrc.yml'),
      'root: ./.cnos\n',
    );
    await mkdir(path.join(repoRoot, '.cnos'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.cnos', 'cnos.yml'),
      ['version: 1', 'project:', '  name: monorepo-fixture', 'profiles:', '  default: local'].join('\n'),
    );
    await writeFile(path.join(repoRoot, '.cnos', 'values', 'app.yml'), ['app:', '  name: monorepo'].join('\n'));

    await expect(
      runWorkspace(['enable'], {
        root: repoRoot,
      }),
    ).resolves.toContain('enabled workspace mode');
    await expect(readFile(path.join(repoRoot, '.cnos', 'workspaces', 'base', 'values', 'app.yml'), 'utf8')).resolves.toContain(
      'monorepo',
    );

    await expect(
      runWorkspace(['add', 'insights'], {
        root: repoRoot,
        cliArgs: ['--package-root', path.join(repoRoot, 'apps', 'insights')],
      }),
    ).resolves.toContain('added workspace insights');

    await expect(readFile(path.join(repoRoot, 'apps', 'insights', '.cnosrc.yml'), 'utf8')).resolves.toContain(
      'workspace: insights',
    );
    await expect(readFile(path.join(repoRoot, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'insights:\n      extends:\n        - base',
    );
    await expect(runWorkspace(['list'], { root: repoRoot })).resolves.toContain('insights');

    await expect(runWorkspace(['remove', 'insights'], { root: repoRoot })).resolves.toContain('removed workspace insights');
    await expect(readFile(path.join(repoRoot, '.cnos', 'cnos.yml'), 'utf8')).resolves.not.toContain('insights');
  });

  it('validates schema/public rules and reports doctor diagnostics', async () => {
    const root = await createRuntimeFixture();

    await expect(runValidate({ root, workspace: 'api', processEnv: {}, json: true })).resolves.toContain(
      '"valid": true',
    );
    await expect(runDoctor({ root, workspace: 'api', processEnv: {}, json: true })).resolves.toContain(
      '"gitignore"',
    );
  });

  it('flags secret env mappings in doctor and can remove them in one shot', async () => {
    const root = await createRuntimeFixture();

    await runPromote(['secret.app.token'], {
      root,
      processEnv: {},
      cliArgs: ['--to', 'env', '--as', 'APP_TOKEN', '--allow-secret'],
    });

    await expect(runDoctor({ root, workspace: 'api', processEnv: {} })).resolves.toContain(
      'secret env mapping: APP_TOKEN -> secret.app.token',
    );

    await expect(
      runDoctor({
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--fix-secret-env-mappings'],
      }),
    ).resolves.toContain('REPAIRED secret-env-mappings: removed APP_TOKEN -> secret.app.token');

    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.not.toContain(
      'APP_TOKEN: secret.app.token',
    );
  });

  it('reports schema drift against the resolved graph', async () => {
    const root = await createRuntimeFixture();
    await writeFile(
      path.join(root, '.cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: cli-fixture',
        'workspaces:',
        '  default: api',
        '  global:',
        '    enabled: true',
        '    allowWrite: true',
        '  items:',
        '    api: {}',
        'envMapping:',
        '  convention: SCREAMING_SNAKE',
        '  explicit:',
        '    API_URL: value.api.baseUrl',
        '    SERVER_PORT: value.server.port',
        'public:',
        '  promote:',
        '    - value.api.baseUrl',
        'schema:',
        '  value.server.port:',
        '    type: number',
        '    required: true',
        '  value.server.host:',
        '    type: string',
        '    default: localhost',
        '  secret.db.password:',
        '    type: string',
        '    required: true',
      ].join('\n'),
    );

    await expect(runDrift({ root, workspace: 'api', processEnv: {} })).resolves.toContain('secret.db.password');
    await expect(runDrift({ root, workspace: 'api', processEnv: {}, json: true })).resolves.toContain(
      '"mismatches"',
    );
  });

  it('scans env usage, updates the manifest, and rewrites source files with backups', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-migrate-'));
    fixtureRoots.push(root);
    await mkdir(path.join(root, '.cnos'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(root, '.cnos', 'cnos.yml'),
      ['version: 1', 'project:', '  name: migrate-cli'].join('\n'),
    );
    await writeFile(
      path.join(root, 'src', 'config.ts'),
      ['const host = process.env.DATABASE_HOST;', 'const publicUrl = import.meta.env.VITE_API_URL;'].join('\n'),
    );

    await expect(
      runMigrate({
        root,
        cliArgs: ['--scan', 'src'],
      }),
    ).resolves.toContain('DATABASE_HOST -> value.database.host');
    await expect(
      runMigrate({
        root,
        cliArgs: ['--scan', 'src', '--apply', '--rewrite'],
      }),
    ).resolves.toContain('Updated');
    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'DATABASE_HOST: value.database.host',
    );
    await expect(readFile(path.join(root, 'src', 'config.ts'), 'utf8')).resolves.toContain(
      "import cnos from '@kitsy/cnos';",
    );
    await expect(readFile(path.join(root, 'src', 'config.ts.bak'), 'utf8')).resolves.toContain(
      'process.env.DATABASE_HOST',
    );
  });

  it(
    'watches config changes in signal mode and restart mode',
    async () => {
      const root = await createRuntimeFixture();
      const changed: string[][] = [];
      const signalHandle = await startWatchLoop({
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--signal', '--debounce', '25'],
        onSignal(payload) {
          changed.push(payload.changedKeys);
        },
      });

      try {
        await writeFile(
          path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
          ['app:', '  name: cli-fixture', 'server:', '  port: "8181"', 'api:', '  baseUrl: https://api.local'].join('\n'),
        );
        await waitForCondition(() => changed.some((keys) => keys.includes('value.server.port')));
      } finally {
        await signalHandle.close();
      }

      const restartRoot = await createRuntimeFixture();
      const restarted: string[][] = [];
      const restartHandle = await startWatchLoop({
        root: restartRoot,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--debounce', '25'],
        command: [
          process.execPath,
          '-e',
          'setTimeout(() => process.exit(0), 50)',
        ],
        onRestart(payload) {
          restarted.push(payload.changedKeys);
        },
      });

      try {
        await writeFile(
          path.join(restartRoot, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
          ['app:', '  name: cli-fixture', 'server:', '  port: "9191"', 'api:', '  baseUrl: https://api.local'].join('\n'),
        );
        await waitForCondition(() => restarted.some((keys) => keys.includes('value.server.port')));
      } finally {
        await restartHandle.close();
      }
    },
    15000,
  );

  it(
    'writes and rewrites derived env artifacts in dev env mode while restarting the child process',
    async () => {
      const root = await createRuntimeFixture();
      const outputPath = path.join(root, '.env.local');
      const markerPath = path.join(root, 'dev-env-starts.log');
      const handle = await startDevEnvLoop(
        [
          process.execPath,
          '-e',
          "const fs=require('node:fs'); const marker=process.argv[1]; fs.appendFileSync(marker,'start\\n'); setInterval(() => {}, 1000);",
          markerPath,
        ],
        {
          root,
          workspace: 'api',
          processEnv: {},
          cliArgs: ['--to', outputPath, '--debounce', '25'],
        },
      );

      try {
        await waitForCondition(async () => {
          const content = await readFile(outputPath, 'utf8').catch(() => '');
          return content.includes('API_URL=https://api.local');
        });
        await waitForCondition(async () => {
          const content = await readFile(markerPath, 'utf8').catch(() => '');
          return content.trim().split(/\r?\n/).filter(Boolean).length >= 1;
        });

        await writeFile(
          path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
          ['app:', '  name: cli-fixture', 'server:', '  port: "9191"', 'api:', '  baseUrl: https://api.changed'].join('\n'),
        );

        await waitForCondition(async () => {
          const content = await readFile(outputPath, 'utf8').catch(() => '');
          return content.includes('API_URL=https://api.local') && content.includes('SERVER_PORT=9191');
        }, 10000);
        await waitForCondition(async () => {
          const content = await readFile(markerPath, 'utf8').catch(() => '');
          return content.trim().split(/\r?\n/).filter(Boolean).length >= 2;
        }, 10000);
      } finally {
        await handle.close();
      }
    },
    20000,
  );
});
