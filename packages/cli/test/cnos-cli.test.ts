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
import { runRead } from '../src/commands/read.js';
import { runCommand } from '../src/commands/run.js';
import { runSecret } from '../src/commands/secret.js';
import { runValidate } from '../src/commands/validate.js';
import { runValue } from '../src/commands/value.js';
import { printJson } from '../src/format/printJson.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, 'cnos', 'workspaces', 'api', 'values', 'local'), { recursive: true });
  await mkdir(path.join(root, 'cnos', 'workspaces', 'api', 'values', 'stage'), { recursive: true });
  await mkdir(path.join(root, 'cnos', 'workspaces', 'api', 'secrets', 'local'), { recursive: true });
  await mkdir(path.join(root, 'cnos', 'workspaces', 'api', 'secrets', 'stage'), { recursive: true });
  await writeFile(
    path.join(root, 'cnos', 'cnos.yml'),
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
    path.join(root, 'cnos', 'workspaces', 'api', 'values', 'local', 'app.yml'),
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
    path.join(root, 'cnos', 'workspaces', 'api', 'values', 'stage', 'app.yml'),
    ['server:', '  port: "9090"', 'api:', '  baseUrl: https://api.stage'].join('\n'),
  );
  await writeFile(
    path.join(root, 'cnos', 'workspaces', 'api', 'secrets', 'local', 'app.yml'),
    ['app:', '  token: super-secret'].join('\n'),
  );
  await writeFile(
    path.join(root, 'cnos', 'workspaces', 'api', 'secrets', 'stage', 'app.yml'),
    ['app:', '  token: stage-secret'].join('\n'),
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
  });

  it('scaffolds the workspace-aware starter tree and gitignore entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-init-'));
    fixtureRoots.push(root);

    await runInit({
      root,
      workspace: 'api',
    });

    await expect(readFile(path.join(root, 'cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'default: api',
    );
    await expect(readFile(path.join(root, '.cnos-workspace.yml'), 'utf8')).resolves.toContain(
      'workspace: api',
    );
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      'cnos/workspaces/*/secrets/',
    );
  });

  it('formats json output', () => {
    expect(printJson({ ok: true })).toContain('"ok": true');
  });

  it('prints human help for the root CLI and command topics', () => {
    expect(runHelp()).toContain('Commands');
    expect(runHelp()).toContain('help-ai');
    expect(runHelp('define')).toContain('Usage: cnos define <value|secret> <path> <rawValue>');
    expect(runHelp('export env')).toContain('--public');
  });

  it('prints machine-readable help for agents', () => {
    const rootPayload = JSON.parse(runHelpAi(undefined, ['--format', 'json']));
    const commandPayload = JSON.parse(runHelpAi('export env', ['--format=json']));

    expect(rootPayload.cli).toBe('cnos');
    expect(rootPayload.commands.some((command: { id: string }) => command.id === 'doctor')).toBe(true);
    expect(commandPayload.command.id).toBe('export env');
    expect(commandPayload.command.options.some((option: { flag: string }) => option.flag === '--public')).toBe(
      true,
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
      'super-secret',
    );
  });

  it('prints inspect output in text and json modes', async () => {
    const root = await createRuntimeFixture();

    await expect(runInspect('value.server.port', { root, workspace: 'api', processEnv: {} })).resolves.toMatchInlineSnapshot(`
      "key: value.server.port
      value: 8080
      namespace: value
      profile: local (manifest-default)
      workspace: api (cli)
      workspaceChain: api
      winner: filesystem-values via @kitsy/cnos-plugin-filesystem @ api
      winnerOrigin: cnos/workspaces/api/values/local/app.yml"
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
      readFile(path.join(root, 'cnos', 'workspaces', 'api', 'values', 'local', 'app.yml'), 'utf8'),
    ).resolves.toContain('3001');

    await expect(
      runDefine('secret', 'app.token', 'global-secret', {
        root,
        workspace: 'api',
        globalRoot,
        processEnv: {},
        cliArgs: ['--target', 'global'],
      }),
    ).resolves.toContain(globalRoot);
    await expect(
      readFile(path.join(globalRoot, 'workspaces', 'api', 'secrets', 'local', 'app.yml'), 'utf8'),
    ).resolves.toContain('global-secret');
  });

  it('exports env projections and dumps snapshot files', async () => {
    const root = await createRuntimeFixture();
    const dumpRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-dump-'));
    fixtureRoots.push(dumpRoot);

    await expect(
      runExport('env', {
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--public', '--framework', 'vite'],
      }),
    ).resolves.toMatchInlineSnapshot(`
      "VITE_API_URL=https://api.local"
    `);
    await expect(
      runDump({
        root,
        workspace: 'api',
        processEnv: {},
        cliArgs: ['--flatten', '--to', dumpRoot],
      }),
    ).resolves.toContain(dumpRoot);
    await expect(readFile(path.join(dumpRoot, 'values', 'local', 'app.yml'), 'utf8')).resolves.toContain(
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
    await expect(runDiff('local', 'stage', { root, workspace: 'api', processEnv: {} })).resolves.toContain(
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
