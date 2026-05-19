import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDoctor } from '../src/commands/doctor.js';
import { runSpec } from '../src/commands/spec.js';
import * as maskedPrompt from '../src/services/maskedPrompt.js';

const fixtureRoots: string[] = [];

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSpecDoctorFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-spec-doctor-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: spec-doctor-fixture',
      'vaults:',
      '  default:',
      '    provider: environment',
      'schema:',
      '  value.server.port:',
      '    type: number',
      '    required: true',
      '    summary: HTTP port',
      '  value.server.host:',
      '    type: string',
      '    default: localhost',
      '  value.app.stage:',
      '    type: string',
      '    enum: [local, stage, prod]',
      '  value.legacy.flag:',
      '    type: boolean',
      '    deprecated: true',
      '  secret.db.password:',
      '    type: string',
      '    required: true',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    ['server:', '  port: "3000"', 'app:', '  stage: dev', 'legacy:', '  flag: true'].join('\n'),
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

async function createRemoteSpecDoctorFixture(): Promise<{ consumerRoot: string; cacheDir: string }> {
  const repoRoot = await createSpecDoctorFixture();
  const consumerRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-spec-doctor-remote-consumer-'));
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-spec-doctor-remote-cache-'));
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

async function withInteractiveTty(run: () => Promise<void>): Promise<void> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

  try {
    await run();
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }
  }
}

describe('spec doctor command', () => {
  it('reports schema/spec coverage in report mode and sets exitCode for blocking statuses', async () => {
    const root = await createSpecDoctorFixture();
    const output = await runSpec(['doctor'], {
      root,
      processEnv: {},
    });

    expect(output).toContain('missingRequired=1');
    expect(output).toContain('enumMismatch=1');
    expect(output).toContain('deprecatedInUse=1');
    expect(process.exitCode).toBe(1);
  });

  it('supports report-mode json output contract', async () => {
    const root = await createSpecDoctorFixture();
    const output = await runSpec(['doctor'], {
      root,
      processEnv: {},
      json: true,
    });
    const parsed = JSON.parse(output) as {
      mode: string;
      summary: Record<string, number>;
      issues: Array<{ status: string }>;
    };

    expect(parsed.mode).toBe('report');
    expect(parsed.summary.missingRequired).toBe(1);
    expect(parsed.issues.some((issue) => issue.status === 'missing_required')).toBe(true);
  });

  it('rejects json output for interactive doctor modes', async () => {
    const root = await createSpecDoctorFixture();

    await expect(
      runSpec(['doctor'], {
        root,
        processEnv: {},
        json: true,
        cliArgs: ['--fill-missing'],
      }),
    ).rejects.toThrow('--fill-missing');
    await expect(
      runSpec(['doctor'], {
        root,
        processEnv: {},
        json: true,
        cliArgs: ['--review-all'],
      }),
    ).rejects.toThrow('--review-all');
  });

  it('rejects non-interactive write modes without tty', async () => {
    const root = await createSpecDoctorFixture();

    await expect(
      runSpec(['doctor'], {
        root,
        processEnv: {},
        cliArgs: ['--fill-missing'],
      }),
    ).rejects.toThrow('interactive TTY');
    await expect(
      runSpec(['doctor'], {
        root,
        processEnv: {},
        cliArgs: ['--review-all'],
      }),
    ).rejects.toThrow('interactive TTY');
  });

  it('fills missing required keys in fill-missing mode and prompts only for missing-required entries', async () => {
    const root = await createSpecDoctorFixture();
    const promptMaskedInput = vi.spyOn(maskedPrompt, 'promptMaskedInput').mockResolvedValue('super-secret');
    const promptInput = vi.spyOn(maskedPrompt, 'promptInput').mockResolvedValue('unused');

    await withInteractiveTty(async () => {
      const output = await runSpec(['doctor'], {
        root,
        processEnv: {},
        cliArgs: ['--fill-missing'],
      });

      expect(output).toContain('Actions:');
      expect(output).toContain('secret.db.password: applied');
      expect(output).not.toContain('super-secret');
    });

    expect(promptMaskedInput).toHaveBeenCalledTimes(1);
    expect(promptInput).not.toHaveBeenCalled();
    expect(promptMaskedInput).toHaveBeenCalledWith('Enter value for secret.db.password: ');

    const secretFile = await readFile(path.join(root, '.cnos', 'secrets', 'db.yml'), 'utf8');
    expect(secretFile).toContain('provider: environment');
    expect(secretFile).toContain('ref: super-secret');
  });

  it('marks review-all skip on missing-required keys as blocking (exit 1)', async () => {
    const root = await createSpecDoctorFixture();
    const promptInput = vi
      .spyOn(maskedPrompt, 'promptInput')
      .mockResolvedValue('s');

    await withInteractiveTty(async () => {
      const output = await runSpec(['doctor'], {
        root,
        processEnv: {},
        cliArgs: ['--review-all'],
      });

      expect(output).toContain('secret.db.password: skipped (skip)');
      expect(process.exitCode).toBe(1);
    });

    expect(promptInput).toHaveBeenCalled();
  });

  it('rejects doctor write modes for remote read-only roots', async () => {
    const fixture = await createRemoteSpecDoctorFixture();
    const processEnv = {
      ...process.env,
      CNOS_CACHE_DIR: fixture.cacheDir,
    };

    await expect(
      runSpec(['doctor'], {
        cwd: fixture.consumerRoot,
        processEnv,
        cliArgs: ['--fill-missing'],
      }),
    ).rejects.toThrow('remote and read-only');
    await expect(
      runSpec(['doctor'], {
        cwd: fixture.consumerRoot,
        processEnv,
        cliArgs: ['--review-all'],
      }),
    ).rejects.toThrow('remote and read-only');
  });

  it('cnos doctor includes spec doctor pointer when schema is non-empty', async () => {
    const root = await createSpecDoctorFixture();
    const output = await runDoctor({
      root,
      processEnv: {},
    });

    expect(output).toContain('Run cnos spec doctor to review config spec coverage.');
  });
});
