import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/parseArgs.js';
import { runVar } from '../src/commands/var.js';
import { findHelpCommand } from '../src/cli/helpRegistry.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempStore(): Promise<{ root: string; store: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-var-cli-'));
  roots.push(root);
  return { root, store: path.join(root, 'var-log.jsonl') };
}

async function invoke(argv: string[], root: string): Promise<unknown> {
  const parsed = parseArgs(argv);
  const output = await runVar(parsed.args, { cliArgs: parsed.options.cliArgs, json: true, root });
  return JSON.parse(output);
}

describe('cnos var CLI (local file store)', () => {
  it('drives create -> activate -> status -> rollback against a file store', async () => {
    const { root, store } = await tempStore();
    const scope = 'agentic.lanes.vinci';

    const created = (await invoke(
      ['var', 'create', scope, '--document', '{"enabled":true,"model_target_ref":"secret.ops.m"}', '--store', store],
      root,
    )) as { revision: string; created: boolean };
    expect(created.revision).toMatch(/^sha256:/);
    expect(created.created).toBe(true);

    const activated = (await invoke(
      ['var', 'activate', scope, '--revision', created.revision, '--expect-generation', '0', '--store', store],
      root,
    )) as { generation: number };
    expect(activated.generation).toBe(1);

    const status = (await invoke(['var', 'status', scope, '--store', store], root)) as {
      active: boolean;
      generation: number;
    };
    expect(status).toMatchObject({ active: true, generation: 1 });

    const rolled = (await invoke(
      ['var', 'rollback', scope, '--to-generation', '1', '--expect-generation', '1', '--store', store],
      root,
    )) as { generation: number };
    expect(rolled.generation).toBe(2);

    const history = (await invoke(['var', 'history', scope, '--store', store], root)) as {
      events: Array<{ kind: string }>;
    };
    expect(history.events.map((event) => event.kind)).toEqual(['revision-created', 'activated', 'activated']);
  });

  it('rejects a stale --expect-generation with a conflict error', async () => {
    const { root, store } = await tempStore();
    const scope = 'user.IN.coupon';
    const created = (await invoke(['var', 'create', scope, '--document', '{"x":1}', '--store', store], root)) as {
      revision: string;
    };
    await invoke(['var', 'activate', scope, '--revision', created.revision, '--expect-generation', '0', '--store', store], root);

    const parsed = parseArgs(['var', 'activate', scope, '--revision', created.revision, '--expect-generation', '0', '--store', store]);
    await expect(runVar(parsed.args, { cliArgs: parsed.options.cliArgs, json: true, root })).rejects.toThrow(/conflict/i);
  });

  it('requires --expect-generation for activate', async () => {
    const { root, store } = await tempStore();
    const parsed = parseArgs(['var', 'activate', 'a.b', '--revision', 'sha256:x', '--store', store]);
    await expect(runVar(parsed.args, { cliArgs: parsed.options.cliArgs, root })).rejects.toThrow(/expect-generation/);
  });

  it('registers every var subcommand in the canonical help registry', () => {
    for (const id of ['var', 'var create', 'var activate', 'var rollback', 'var status', 'var replay', 'var serve']) {
      expect(findHelpCommand(id)?.id).toBe(id);
    }
  });
});
