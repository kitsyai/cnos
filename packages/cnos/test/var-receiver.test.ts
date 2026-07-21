import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConfigEntry, LoaderPlugin } from '@kitsy/cnos-core';

import { createCnos } from '../src/createCnos.js';
import { varReceiver } from '../src/varReceiver.js';

const roots: string[] = [];

async function fixture(manifest: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-recv-'));
  await mkdir(path.join(root, 'cnos'), { recursive: true });
  await writeFile(path.join(root, 'cnos', 'cnos.yml'), manifest);
  roots.push(root);
  return root;
}

function loader(entries: Array<{ key: string; value: unknown }>): LoaderPlugin {
  const configEntries: ConfigEntry[] = entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    namespace: entry.key.split('.')[0] ?? 'value',
    sourceId: 'fixture',
    pluginId: 'fixture',
    workspaceId: 'recv-app',
  }));
  return { id: 'fixture', kind: 'loader', async load() { return configEntries; } };
}

interface MockRes {
  statusCode: number;
  headersSent: boolean;
  body: string;
  writeHead(status: number): MockRes;
  end(body?: string): void;
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    headersSent: false,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(body?: string) {
      if (body) {
        this.body = body;
      }
    },
  };
}

async function invoke(
  handler: ReturnType<typeof varReceiver>,
  req: { method: string; url: string; headers: Record<string, string>; body?: unknown },
): Promise<MockRes> {
  const res = mockRes();
  handler(req as never, res as never);
  for (let i = 0; i < 50 && res.statusCode === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return res;
}

const MANIFEST = [
  'version: 1',
  'project:',
  '  name: recv-app',
  'varSources:',
  '  svc: { transport: http, url: "http://127.0.0.1:59999", verify: secret.ops.verify }',
  'vars:',
  '  flags: { source: svc, mode: ondemand }',
  'schema:',
  '  var.flags.enabled: { type: boolean, default: false }',
  '',
].join('\n');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('varReceiver (latching push)', () => {
  it('routes a verified push through ingest so a subsequent read reflects it', async () => {
    const root = await fixture(MANIFEST);
    const runtime = await createCnos({
      root,
      plugins: [loader([{ key: 'secret.ops.verify', value: 'push-secret' }])],
    });

    expect(runtime.read('var.flags.enabled')).toBe(false); // default

    const handler = varReceiver('svc');
    const res = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/receive/flags',
      headers: { authorization: 'Bearer push-secret' },
      body: { values: { 'flags.enabled': true } },
    });

    expect(res.statusCode).toBe(204);
    expect(runtime.read('var.flags.enabled')).toBe(true);
    await runtime.close?.();
  });

  it('verifies an HMAC push via the `x-cnos-signature: sha256=<hex>` header (prefix required)', async () => {
    const root = await fixture(MANIFEST);
    const runtime = await createCnos({
      root,
      plugins: [loader([{ key: 'secret.ops.verify', value: 'push-secret' }])],
    });

    const body = { values: { 'flags.enabled': true } };
    const raw = JSON.stringify(body);
    const signature = `sha256=${createHmac('sha256', 'push-secret').update(raw).digest('hex')}`;

    const handler = varReceiver('svc');
    const accepted = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/receive/flags',
      headers: { 'x-cnos-signature': signature },
      body,
    });
    expect(accepted.statusCode).toBe(204);
    expect(runtime.read('var.flags.enabled')).toBe(true);

    // A signature WITHOUT the required `sha256=` prefix must fail verification.
    const unprefixed = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/receive/flags',
      headers: { 'x-cnos-signature': createHmac('sha256', 'push-secret').update(raw).digest('hex') },
      body,
    });
    expect(unprefixed.statusCode).toBe(401);

    await runtime.close?.();
  });

  it('rejects a push whose bearer does not match the source verify secret', async () => {
    const root = await fixture(MANIFEST);
    const runtime = await createCnos({
      root,
      plugins: [loader([{ key: 'secret.ops.verify', value: 'push-secret' }])],
    });

    const handler = varReceiver('svc');
    const res = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/receive/flags',
      headers: { authorization: 'Bearer wrong-token' },
      body: { values: { 'flags.enabled': true } },
    });

    expect(res.statusCode).toBe(401);
    expect(runtime.read('var.flags.enabled')).toBe(false); // unchanged
    await runtime.close?.();
  });

  it('backward compat: a manifest with no var blocks yields an empty var status and a safe close', async () => {
    const root = await fixture('version: 1\nproject:\n  name: plain\n');
    const runtime = await createCnos({ root, plugins: [loader([{ key: 'value.a', value: 1 }])] });

    expect(runtime.read('value.a')).toBe(1);
    expect(runtime.varStatus?.()).toEqual({});
    await expect(runtime.close?.()).resolves.toBeUndefined();
  });
});
