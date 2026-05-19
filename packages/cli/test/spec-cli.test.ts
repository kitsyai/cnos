import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArgs } from '../src/cli/parseArgs.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../src/services/spec/specPrompts.js');
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSpecFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-spec-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: spec-cli-fixture',
      'schema:',
      '  value.server.port:',
      '    type: number',
      '    required: true',
      '    summary: HTTP port',
      '  value.legacy.flag:',
      '    type: boolean',
      '    deprecated: true',
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

async function createRemoteSpecFixture(): Promise<{ consumerRoot: string; cacheDir: string }> {
  const repoRoot = await createSpecFixture();
  const consumerRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-spec-remote-consumer-'));
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-spec-remote-cache-'));
  fixtureRoots.push(consumerRoot);
  fixtureRoots.push(cacheDir);
  await runGit(['init'], repoRoot);
  await runGit(['config', 'user.email', 'cnos@example.com'], repoRoot);
  await runGit(['config', 'user.name', 'CNOS Test'], repoRoot);
  await runGit(['add', '.'], repoRoot);
  await runGit(['commit', '-m', 'init-remote'], repoRoot);
  await runGit(['branch', '-M', 'main'], repoRoot);
  const rootUri = `git+${pathToFileURL(repoRoot).href}#main:.cnos`;
  await writeFile(
    path.join(consumerRoot, '.cnosrc.yml'),
    ['root: ' + rootUri, 'workspace: base'].join('\n'),
  );

  return { consumerRoot, cacheDir };
}

async function importRunSpec() {
  const mod = await import('../src/commands/spec.js');
  return mod.runSpec;
}

describe('spec parse args', () => {
  it('captures spec option-value flags and repeatable entries', () => {
    expect(
      parseArgs([
        'spec',
        'set',
        'value.server.port',
        '--type',
        'number',
        '--summary',
        'HTTP port',
        '--example',
        '3000',
        '--example=8080',
        '--used-by',
        'server runtime',
      ]),
    ).toEqual({
      command: 'spec',
      args: ['set', 'value.server.port'],
      options: {
        cliArgs: [
          '--type',
          'number',
          '--summary',
          'HTTP port',
          '--example',
          '3000',
          '--example=8080',
          '--used-by',
          'server runtime',
        ],
      },
      passthrough: [],
    });
  });
});

describe('spec command', () => {
  it('lists and shows spec entries', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await expect(runSpec(['list'], { root, processEnv: {} })).resolves.toContain('value.server.port');
    await expect(runSpec(['show', 'value.server.port'], { root, processEnv: {} })).resolves.toContain('summary');

    const showJson = await runSpec(['show', 'value.server.port'], { root, processEnv: {}, json: true });
    expect(JSON.parse(showJson)).toEqual(
      expect.objectContaining({
        key: 'value.server.port',
        manifestPath: expect.any(String),
        rule: expect.objectContaining({
          type: 'number',
          required: true,
        }),
      }),
    );
  });

  it('creates, updates, and deletes spec entries', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await expect(
      runSpec(['set', 'value.app.stage'], {
        root,
        processEnv: {},
        cliArgs: ['--type', 'string', '--enum', '["local","stage","prod"]', '--summary', 'Deployment stage'],
      }),
    ).resolves.toContain('created spec value.app.stage');

    await expect(
      runSpec(['set', 'value.app.stage'], {
        root,
        processEnv: {},
        cliArgs: ['--clear-enum', '--summary', 'Stage selector'],
      }),
    ).resolves.toContain('updated spec value.app.stage');

    await expect(runSpec(['delete', 'value.app.stage'], { root, processEnv: {} })).resolves.toContain(
      'deleted spec value.app.stage',
    );
  });

  it('rejects plaintext-bearing metadata fields for secret spec keys', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await expect(
      runSpec(['set', 'secret.db.password'], {
        root,
        processEnv: {},
        cliArgs: ['--default', 'super-secret'],
      }),
    ).rejects.toThrow('vault');
    await expect(
      runSpec(['set', 'secret.db.password'], {
        root,
        processEnv: {},
        cliArgs: ['--example', '"abc"'],
      }),
    ).rejects.toThrow('vault');
    await expect(
      runSpec(['set', 'secret.db.password'], {
        root,
        processEnv: {},
        cliArgs: ['--enum', '["a","b"]'],
      }),
    ).rejects.toThrow('vault');
  });

  it('enforces clear flag conflict rules', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await expect(
      runSpec(['set', 'value.server.port'], {
        root,
        processEnv: {},
        cliArgs: ['--summary', 'HTTP port', '--clear-summary'],
      }),
    ).rejects.toThrow('--clear-summary');
    await expect(
      runSpec(['set', 'value.server.port'], {
        root,
        processEnv: {},
        cliArgs: ['--deprecated', '--clear-deprecated'],
      }),
    ).rejects.toThrow('--clear-deprecated');
  });

  it('rejects invalid regex patterns during spec authoring', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await expect(
      runSpec(['set', 'value.server.port'], {
        root,
        processEnv: {},
        cliArgs: ['--pattern', '['],
      }),
    ).rejects.toThrow('Invalid --pattern regex');
  });

  it('fails non-interactive spec set when no field flags are provided', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await expect(runSpec(['set', 'value.server.port'], { root, processEnv: {} })).rejects.toThrow(
      'interactive TTY',
    );
  });

  it('triggers interactive prompt mode when no field flags are provided and interactive mode is available', async () => {
    const root = await createSpecFixture();
    const promptSpecSetInput = vi.fn().mockResolvedValue({
      set: { summary: 'Server port' },
      clear: [],
      hasFieldFlags: true,
      cliArgs: [],
    });

    vi.doMock('../src/services/spec/specPrompts.js', () => ({
      isInteractiveSpecPromptMode: () => true,
      promptSpecSetInput,
    }));

    const runSpec = await importRunSpec();
    await runSpec(['set', 'value.server.port'], { root, processEnv: {} });
    expect(promptSpecSetInput).toHaveBeenCalledWith('value.server.port');
  });

  it('rejects spec set --json without field flags', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await expect(runSpec(['set', 'value.server.port'], { root, processEnv: {}, json: true })).rejects.toThrow(
      'interactive JSON mode is not supported',
    );
  });

  it('writes sorted schema entries into the manifest', async () => {
    const root = await createSpecFixture();
    const runSpec = await importRunSpec();

    await runSpec(['set', 'value.app.alpha'], {
      root,
      processEnv: {},
      cliArgs: ['--type', 'string'],
    });
    await runSpec(['set', 'value.app.zeta'], {
      root,
      processEnv: {},
      cliArgs: ['--type', 'string'],
    });

    const manifest = await readFile(path.join(root, '.cnos', 'cnos.yml'), 'utf8');
    expect(manifest.indexOf('value.app.alpha:')).toBeLessThan(manifest.indexOf('value.app.zeta:'));
  });

  it('rejects spec set and delete for remote read-only roots', async () => {
    const fixture = await createRemoteSpecFixture();
    const runSpec = await importRunSpec();
    const processEnv = {
      ...process.env,
      CNOS_CACHE_DIR: fixture.cacheDir,
    };

    await expect(
      runSpec(['set', 'value.app.stage'], {
        cwd: fixture.consumerRoot,
        processEnv,
        cliArgs: ['--type', 'string'],
      }),
    ).rejects.toThrow('remote and read-only');
    await expect(
      runSpec(['delete', 'value.server.port'], {
        cwd: fixture.consumerRoot,
        processEnv,
      }),
    ).rejects.toThrow('remote and read-only');
  });
});
