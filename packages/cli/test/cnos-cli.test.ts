import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/parseArgs.js';
import { runDefine } from '../src/commands/define.js';
import { runDiff } from '../src/commands/diff.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runDump } from '../src/commands/dump.js';
import { runExport } from '../src/commands/export.js';
import { runHelp } from '../src/commands/help.js';
import { runHelpAi } from '../src/commands/helpAi.js';
import { runInit } from '../src/commands/init.js';
import { runInspect } from '../src/commands/inspect.js';
import { runList } from '../src/commands/list.js';
import { runOnboard } from '../src/commands/onboard.js';
import { runRead } from '../src/commands/read.js';
import { runPromote } from '../src/commands/promote.js';
import { runCommand } from '../src/commands/run.js';
import { runSecret } from '../src/commands/secret.js';
import { runUse } from '../src/commands/use.js';
import { runValidate } from '../src/commands/validate.js';
import { runVault } from '../src/commands/vault.js';
import { runVersion } from '../src/commands/version.js';
import { runValue } from '../src/commands/value.js';
import { printJson } from '../src/format/printJson.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

  it('scaffolds the workspace-aware starter tree and gitignore entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-init-'));
    fixtureRoots.push(root);

    await runInit({
      root,
      workspace: 'api',
    });

    await expect(readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'default: api',
    );
    await expect(readFile(path.join(root, '.cnos-workspace.yml'), 'utf8')).resolves.toContain(
      'workspace: api',
    );
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      '.cnos/workspaces/*/env/.env',
    );
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      '!.cnos/workspaces/*/env/.env.*.example',
    );
  });

  it('formats json output', () => {
    expect(printJson({ ok: true })).toContain('"ok": true');
  });

  it('prints the CLI version', () => {
    expect(runVersion()).toBe('1.2.0');
  });

  it('shows current CLI context without creating .cnos-workspace.yml', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-use-'));
    fixtureRoots.push(root);

    await expect(runUse(['show'], { root })).resolves.toBe('no CLI context configured');
    await expect(readFile(path.join(root, '.cnos-workspace.yml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('prints human help for the root CLI and command topics', () => {
    expect(runHelp()).toContain('Commands');
    expect(runHelp()).toContain('help-ai');
    expect(runHelp()).toContain('Framework integrations');
    expect(runHelp()).toContain('@kitsy/cnos-next');
    expect(runHelp()).toContain('promote');
    expect(runHelp()).toContain('vault');
    expect(runHelp('define')).toContain('Usage: cnos define <value|secret> <path> <rawValue>');
    expect(runHelp('promote')).toContain('Usage: cnos promote <key...> --to <public|env>');
    expect(runHelp('vault create')).toContain('Usage: cnos vault create <name>');
    expect(runHelp('value set')).toContain('Usage: cnos value set <path> <value>');
    expect(runHelp('list')).toContain('--namespace <value|secret|meta|env|public|all>');
    expect(runHelp('list')).toContain('--framework <name>');
    expect(runHelp('export env')).toContain('--framework <name>');
    expect(runHelp('export env')).toContain('--to <path>');
  });

  it('prints machine-readable help for agents', () => {
    const rootPayload = JSON.parse(runHelpAi(undefined, ['--format', 'json']));
    const commandPayload = JSON.parse(runHelpAi('export env', ['--format=json']));

    expect(rootPayload.cli).toBe('cnos');
    expect(rootPayload.commands.some((command: { id: string }) => command.id === 'doctor')).toBe(true);
    expect(rootPayload.integrations.some((integration: { id: string }) => integration.id === 'next')).toBe(true);
    expect(commandPayload.command.id).toBe('export env');
    expect(commandPayload.command.options.some((option: { flag: string }) => option.flag === '--public')).toBe(
      true,
    );
    expect(commandPayload.integrations.some((integration: { id: string }) => integration.id === 'vite')).toBe(true);
  });

  it('onboards root env files into the workspace env tree without deleting originals by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-onboard-'));
    fixtureRoots.push(root);
    await writeFile(path.join(root, '.env'), 'VITE_DEPLOY_ENV=local\n');
    await writeFile(path.join(root, '.env.stage'), 'VITE_DEPLOY_ENV=stage\n');
    await writeFile(path.join(root, '.env.stage.example'), 'VITE_DEPLOY_ENV=stage\n');

    await expect(runOnboard({ root, workspace: 'webapp' })).resolves.toContain('imported 3 root env files');
    await expect(readFile(path.join(root, '.cnos', 'workspaces', 'webapp', 'env', '.env'), 'utf8')).resolves.toContain(
      'VITE_DEPLOY_ENV=local',
    );
    await expect(readFile(path.join(root, '.cnos', 'workspaces', 'webapp', 'env', '.env.stage'), 'utf8')).resolves.toContain(
      'VITE_DEPLOY_ENV=stage',
    );
    await expect(readFile(path.join(root, '.env'), 'utf8')).resolves.toContain('VITE_DEPLOY_ENV=local');
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
      'super-secret',
    );
  });

  it('resolves vault-backed secrets through read and secret get when a passphrase is provided', async () => {
    const root = await createRuntimeFixture();
    const secretHome = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-secret-read-'));
    fixtureRoots.push(secretHome);

    await runVault(['create', 'default'], {
      root,
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
      },
      cliArgs: ['--passphrase', 'dev-pass'],
    });

    await runSecret(['set', 'app.token', 'super-secret'], {
      root,
      workspace: 'api',
      processEnv: {
        CNOS_SECRET_HOME: secretHome,
      },
      cliArgs: ['--local', '--vault', 'default', '--passphrase', 'dev-pass'],
    });

    await expect(
      runRead('secret.app.token', {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default', '--passphrase', 'dev-pass'],
      }),
    ).resolves.toBe('super-secret');

    await expect(
      runSecret(['get', 'app.token'], {
        root,
        workspace: 'api',
        processEnv: {
          CNOS_SECRET_HOME: secretHome,
        },
        cliArgs: ['--vault', 'default', '--passphrase', 'dev-pass'],
      }),
    ).resolves.toBe('super-secret');
  });

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
    fixtureRoots.push(globalRoot);

    await expect(
      runDefine('value', 'server.port', '3001', {
        root,
        workspace: 'api',
        processEnv: {},
      }),
    ).resolves.toContain('defined value.server.port');
    await expect(
      readFile(path.join(root, '.cnos', 'workspaces', 'api', 'values', 'server.yml'), 'utf8'),
    ).resolves.toContain('3001');

    await expect(
      runDefine('secret', 'app.token', 'global-secret', {
        root,
        workspace: 'api',
        globalRoot,
        processEnv: {
          CNOS_SECRET_PASSPHRASE: 'dev-pass',
        },
        cliArgs: ['--target', 'global', '--passphrase', 'dev-pass'],
      }),
    ).resolves.toContain(globalRoot);
    await expect(
      readFile(path.join(globalRoot, 'workspaces', 'api', 'secrets', 'app.yml'), 'utf8'),
    ).resolves.toContain('provider: local');
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
        },
        cliArgs: ['--passphrase', 'dev-pass'],
      }),
    ).resolves.toContain('created vault "db"');

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
    ).resolves.toContain('github-ci provider=github-secrets passphrase=none');

    await expect(
      runSecret(['set', 'db.password', 'DB_PASSWORD'], {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--vault', 'github-ci'],
      }),
    ).resolves.toContain('via github-secrets');

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
    ).resolves.toContain('secret.db.password=ci-secret');

    await expect(
      runVault(['remove', 'github-ci'], {
        root,
        processEnv: {},
      }),
    ).resolves.toContain('removed vault "github-ci"');
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

  it('validates schema/public rules and reports doctor diagnostics', async () => {
    const root = await createRuntimeFixture();

    await expect(runValidate({ root, workspace: 'api', processEnv: {}, json: true })).resolves.toContain(
      '"valid": true',
    );
    await expect(runDoctor({ root, workspace: 'api', processEnv: {}, json: true })).resolves.toContain(
      '"gitignore"',
    );
  });
});
