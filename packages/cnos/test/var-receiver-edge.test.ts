import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigEntry, LoaderPlugin } from '@kitsy/cnos-core';

import { createCnos } from '../src/createCnos.js';
import { varReceiver } from '../src/varReceiver.js';

/**
 * W5b test hardening for the Node push receiver: replay/out-of-order semantics, malformed
 * bodies, signature edge cases, and secret-leak regressions.
 *
 * `PINNED:` encodes behavior the design doc left open (notably the out-of-order conflict rule).
 */

const roots: string[] = [];

async function fixture(manifest: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-recv-edge-'));
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

/** Invoke the handler with a pre-parsed `body` (express style) or a raw string stream. */
async function invoke(
  handler: ReturnType<typeof varReceiver>,
  req: { method: string; url: string; headers: Record<string, string>; body?: unknown; raw?: string },
): Promise<MockRes> {
  const res = mockRes();
  const request =
    req.raw !== undefined
      ? {
          method: req.method,
          url: req.url,
          headers: req.headers,
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(req.raw as string, 'utf8');
          },
        }
      : req;

  handler(request as never, res as never);
  for (let i = 0; i < 200 && res.statusCode === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return res;
}

const SECRET = 'push-secret';
const SECRET_LITERAL = 'SUPER-SECRET-MATERIAL-9f3a';

const MANIFEST = [
  'version: 1',
  'project:',
  '  name: recv-app',
  'varSources:',
  '  svc: { transport: http, url: "http://127.0.0.1:9", verify: secret.ops.verify }',
  '  unverified: { transport: http, url: "http://127.0.0.1:9" }',
  'vars:',
  '  flags: { source: svc, mode: ondemand }',
  'schema:',
  '  var.flags.enabled: { type: boolean, default: false }',
  '  var.flags.label: { type: string }',
  '',
].join('\n');

async function runtimeFor(manifest = MANIFEST): Promise<Awaited<ReturnType<typeof createCnos>>> {
  const root = await fixture(manifest);
  return createCnos({
    root,
    plugins: [loader([{ key: 'secret.ops.verify', value: SECRET }])],
  });
}

function signed(body: unknown): { raw: string; headers: Record<string, string> } {
  const raw = JSON.stringify(body);
  return {
    raw,
    headers: { 'x-cnos-signature': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Replay / ordering — the design doc's open item
// ---------------------------------------------------------------------------

describe('receiver replay and ordering semantics', () => {
  it('PINNED: a replayed IDENTICAL push is idempotent — 204 each time, watcher fires once', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const fires: unknown[] = [];
    runtime.watch?.('var.flags.enabled', (next) => fires.push(next.value));

    const payload = { generation: 5, revision: 'sha256:fixed', values: { 'flags.enabled': true } };
    for (let i = 0; i < 3; i += 1) {
      const res = await invoke(handler, {
        method: 'POST',
        url: '/cnos/vars/push/flags',
        headers: { authorization: `Bearer ${SECRET}` },
        body: payload,
      });
      expect(res.statusCode).toBe(204);
    }

    expect(runtime.read('var.flags.enabled')).toBe(true);
    // The watcher gate is (revision, generation): an exact replay is silent.
    expect(fires).toEqual([true]);
    await runtime.close?.();
  });

  it('PINNED: out-of-order pushes are LAST-WRITE-WINS — an older generation overwrites a newer one', async () => {
    // The design doc listed this as open ("highest revision wins else last-write-wins").
    // The implementation does NO generation/revision ordering check on ingest. The final
    // state is whatever arrived last. Pinned as today's contract — see the W5b report.
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');

    const newer = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { generation: 99, revision: 'sha256:new', values: { 'flags.label': 'newer' } },
    });
    expect(newer.statusCode).toBe(204);
    expect(runtime.read('var.flags.label')).toBe('newer');

    const older = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { generation: 2, revision: 'sha256:old', values: { 'flags.label': 'older' } },
    });
    expect(older.statusCode).toBe(204);
    expect(runtime.read('var.flags.label')).toBe('older');
    expect(runtime.varSnapshot?.('var.flags.label')?.generation).toBe(2);
    expect(runtime.varStatus?.()['flags.label']?.appliedGeneration).toBe(2);

    await runtime.close?.();
  });

  it('PINNED: a push omitting revision/generation derives revision=sha256(canonical) and generation=now', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const before = Date.now();

    const res = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { values: { 'flags.enabled': true } },
    });
    expect(res.statusCode).toBe(204);

    const snapshot = runtime.varSnapshot?.('var.flags.enabled');
    expect(snapshot?.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot?.generation).toBeGreaterThanOrEqual(before);
    expect(snapshot?.generation).toBeLessThanOrEqual(Date.now());
    await runtime.close?.();
  });

  it('DEFECT-PIN: unchanged content re-fires watchers whenever the generation differs', async () => {
    // The derived revision is content-addressed, so an UNCHANGED document keeps its revision
    // — but a revision-less push also stamps `generation = Date.now()`. The watcher gate is
    // (revision, generation), so two identical no-op pushes land in different milliseconds and
    // spuriously wake every watcher. Pinned here with explicit generations so the assertion is
    // deterministic; the wall-clock variant is the same hazard with a race attached.
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const fires: unknown[] = [];
    runtime.watch?.('var.flags.enabled', (next) => fires.push(next.value));

    const REVISION = 'sha256:content-addressed-unchanged';
    for (const generation of [1000, 1001, 1002]) {
      const res = await invoke(handler, {
        method: 'POST',
        url: '/cnos/vars/push/flags',
        headers: { authorization: `Bearer ${SECRET}` },
        body: { revision: REVISION, generation, values: { 'flags.enabled': true } },
      });
      expect(res.statusCode).toBe(204);
    }

    // Value never changed, yet the watcher fired for every push.
    expect(fires).toEqual([true, true, true]);
    // The same revision+generation replayed is correctly silent.
    await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { revision: REVISION, generation: 1002, values: { 'flags.enabled': true } },
    });
    expect(fires).toEqual([true, true, true]);
    await runtime.close?.();
  });
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe('receiver adversarial input', () => {
  it('405s any non-POST method', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const res = await invoke(handler, { method, url: '/cnos/vars/push/flags', headers: {} });
      expect(res.statusCode).toBe(405);
    }
    await runtime.close?.();
  });

  it('400s truncated / invalid JSON without crashing', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    for (const raw of ['{', '{"values":', '[1,2', 'nope', '{"values":{}}}']) {
      const signature = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
      const res = await invoke(handler, {
        method: 'POST',
        url: '/cnos/vars/push/flags',
        headers: { 'x-cnos-signature': signature },
        raw,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('bad-request');
    }
    await runtime.close?.();
  });

  it('400s when `values` is missing, null, an array, or a scalar', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    for (const body of [{}, { values: null }, { values: [1, 2] }, { values: 'str' }, { values: 42 }, { values: true }]) {
      const { raw, headers } = signed(body);
      const res = await invoke(handler, { method: 'POST', url: '/cnos/vars/push/flags', headers, raw });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('bad-request');
    }
    await runtime.close?.();
  });

  it('400s when the URL carries no trailing scope segment', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    for (const url of ['/', '', '///', '/?x=1']) {
      const res = await invoke(handler, {
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${SECRET}` },
        body: { values: { 'flags.enabled': true } },
      });
      expect(res.statusCode).toBe(400);
    }
    await runtime.close?.();
  });

  it('422s a schema-violating push and KEEPS last-known-good (acceptance #5)', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');

    await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { values: { 'flags.enabled': true } },
    });
    expect(runtime.read('var.flags.enabled')).toBe(true);

    const rejected = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { values: { 'flags.enabled': 'not-a-boolean' } },
    });
    expect(rejected.statusCode).toBe(422);
    const payload = JSON.parse(rejected.body) as { code: string; issues: Array<{ code: string }> };
    expect(payload.code).toBe('validation-rejected');
    expect(payload.issues[0]?.code).toBe('var.type');
    // Last-known-good is retained.
    expect(runtime.read('var.flags.enabled')).toBe(true);
    await runtime.close?.();
  });

  it('SLOW-ISH: accepts a multi-megabyte push body without hanging when the cap is raised', async () => {
    const runtime = await runtimeFor();
    // The 1 MiB default is deliberate (W5d/D3); a deployment that genuinely pushes large
    // documents opts in explicitly.
    const handler = varReceiver('svc', { maxBodyBytes: 8 * 1024 * 1024 });
    const blob = 'z'.repeat(3 * 1024 * 1024);
    const { raw, headers } = signed({ values: { 'flags.label': blob } });

    const res = await invoke(handler, { method: 'POST', url: '/cnos/vars/push/flags', headers, raw });
    expect(res.statusCode).toBe(204);
    expect((runtime.read('var.flags.label') as string).length).toBe(blob.length);
    // The status surface must not inline the payload.
    expect(JSON.stringify(runtime.varStatus?.() ?? {}).length).toBeLessThan(2_000);
    await runtime.close?.();
  }, 20_000);

  it('W5d/D3: the Node receiver caps the body at 1 MiB by default and 413s past it', async () => {
    // `readRawBody` used to drain the whole stream unbounded — a memory-exhaustion vector on
    // a public mount. It now stops at the cap (default DEFAULT_MAX_VAR_BODY_BYTES = 1 MiB)
    // and reports 413 payload-too-large, the same status the Go receiver now returns.
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const oversized = 'q'.repeat(2 * 1024 * 1024); // > 1 MiB
    const { raw, headers } = signed({ values: { 'flags.label': oversized } });
    const res = await invoke(handler, { method: 'POST', url: '/cnos/vars/push/flags', headers, raw });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).code).toBe('payload-too-large');
    // Nothing was committed.
    expect(runtime.read('var.flags.label')).toBeUndefined();

    // A configurable cap is honored in both directions.
    const tiny = varReceiver('svc', { maxBodyBytes: 8 });
    const small = signed({ values: { 'flags.label': 'still-too-big-for-8-bytes' } });
    const rejected = await invoke(tiny, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: small.headers,
      raw: small.raw,
    });
    expect(rejected.statusCode).toBe(413);
    await runtime.close?.();
  }, 20_000);

  it('decodes a percent-encoded scope segment from the URL', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const res = await invoke(handler, {
      method: 'POST',
      url: `/cnos/vars/push/${encodeURIComponent('flags.enabled')}?ignored=1`,
      headers: { authorization: `Bearer ${SECRET}` },
      body: { values: { 'flags.enabled': true } },
    });
    expect(res.statusCode).toBe(204);
    expect(runtime.read('var.flags.enabled')).toBe(true);
    await runtime.close?.();
  });
});

// ---------------------------------------------------------------------------
// Signature / auth edge cases
// ---------------------------------------------------------------------------

describe('receiver signature verification', () => {
  it('401s a signature missing the required `sha256=` prefix, and one with the wrong algorithm label', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const body = { values: { 'flags.enabled': true } };
    const raw = JSON.stringify(body);
    const digest = createHmac('sha256', SECRET).update(raw).digest('hex');

    for (const signature of [digest, `sha1=${digest}`, `sha256:${digest}`, `SHA256=${digest}`, `sha256= ${digest}`, '']) {
      const res = await invoke(handler, {
        method: 'POST',
        url: '/cnos/vars/push/flags',
        headers: signature ? { 'x-cnos-signature': signature } : {},
        raw,
      });
      expect(res.statusCode).toBe(401);
    }
    expect(runtime.read('var.flags.enabled')).toBe(false);
    await runtime.close?.();
  });

  it('401s when the signature is computed over a DIFFERENT body (tamper detection)', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const signature = `sha256=${createHmac('sha256', SECRET).update(JSON.stringify({ values: { 'flags.enabled': false } })).digest('hex')}`;

    const res = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { 'x-cnos-signature': signature },
      raw: JSON.stringify({ values: { 'flags.enabled': true } }),
    });
    expect(res.statusCode).toBe(401);
    await runtime.close?.();
  });

  it('the signature comparison is length-safe (a truncated signature is rejected, not thrown)', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const raw = JSON.stringify({ values: { 'flags.enabled': true } });
    const digest = createHmac('sha256', SECRET).update(raw).digest('hex');

    // timingSafeEqual throws on unequal lengths — safeEqual must pre-check length.
    for (const signature of [`sha256=${digest.slice(0, 10)}`, `sha256=${digest}${digest}`, 'sha256=']) {
      const res = await invoke(handler, {
        method: 'POST',
        url: '/cnos/vars/push/flags',
        headers: { 'x-cnos-signature': signature },
        raw,
      });
      expect(res.statusCode).toBe(401);
    }
    await runtime.close?.();
  });

  it('W5d/D9: signature PRESENCE decides the scheme — the bearer is not a fallback for a bad signature', async () => {
    // Canonical in both SDKs: header present -> the signature decides (a wrong signature is a
    // 401 even alongside a valid bearer, a valid signature wins alongside a wrong bearer);
    // header absent -> the bearer decides. One presence-based rule, no either-or acceptance.
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    const body = { values: { 'flags.enabled': true } };
    const { raw, headers } = signed(body);

    const wrongSignature = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { 'x-cnos-signature': 'sha256=deadbeef', authorization: `Bearer ${SECRET}` },
      raw,
    });
    expect(wrongSignature.statusCode).toBe(401);

    const validSignature = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { ...headers, authorization: 'Bearer wrong-token' },
      raw,
    });
    expect(validSignature.statusCode).toBe(204);
    await runtime.close?.();
  });

  it('honors a custom signatureHeader option (case-insensitively)', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc', { signatureHeader: 'X-Custom-Sig' });
    const raw = JSON.stringify({ values: { 'flags.enabled': true } });
    const res = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { 'x-custom-sig': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` },
      raw,
    });
    expect(res.statusCode).toBe(204);
    await runtime.close?.();
  });

  it('W5d/D4: a source with NO `verify` ref FAILS CLOSED (401), it does not accept the push', async () => {
    // A receiver is an inbound write path, so an undeclared `verify` secret is a
    // misconfiguration — never an invitation to accept unauthenticated pushes. Matches the
    // Go receiver, which 401s the same case. A bearer/signature cannot rescue it either:
    // there is no secret to compare against.
    const runtime = await runtimeFor();
    const handler = varReceiver('unverified', { onError: () => undefined });

    for (const headers of [{}, { authorization: `Bearer ${SECRET}` }, { 'x-cnos-signature': 'sha256=deadbeef' }]) {
      const res = await invoke(handler, {
        method: 'POST',
        url: '/cnos/vars/push/flags',
        headers,
        body: { values: { 'flags.enabled': true } },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).code).toBe('unauthorized');
    }

    // The default (false) survives: nothing was committed.
    expect(runtime.read('var.flags.enabled')).toBe(false);
    await runtime.close?.();
  });

  it('W5d/D4: a receiver mounted for an UNDECLARED source is 404, not an open door', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('does-not-exist');
    const res = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { values: { 'flags.enabled': true } },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('unknown-source');
    await runtime.close?.();
  });

  it('503s when no var runtime is active (receiver mounted before ready)', async () => {
    // A fresh module registry gives a singleton that no earlier test has populated.
    vi.resetModules();
    const { varReceiver: freshReceiver } = await import('../src/varReceiver.js');
    const handler = freshReceiver('svc');
    const res = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { values: { 'flags.enabled': true } },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('not-ready');
  });
});

// ---------------------------------------------------------------------------
// Security regressions
// ---------------------------------------------------------------------------

describe('receiver security regressions', () => {
  it('SEC: the verify secret never appears in any response body or in varStatus()', async () => {
    const root = await fixture(MANIFEST);
    const runtime = await createCnos({
      root,
      plugins: [loader([{ key: 'secret.ops.verify', value: SECRET_LITERAL }])],
    });
    const handler = varReceiver('svc');

    const bad = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: 'Bearer wrong' },
      body: { values: { 'flags.enabled': true } },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).not.toContain(SECRET_LITERAL);

    const rejected = await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET_LITERAL}` },
      body: { values: { 'flags.enabled': SECRET_LITERAL } },
    });
    expect(rejected.statusCode).toBe(422);
    // A validation issue names the key and the expected type, never the rejected value.
    expect(rejected.body).not.toContain(SECRET_LITERAL);
    expect(JSON.stringify(runtime.varStatus?.() ?? {})).not.toContain(SECRET_LITERAL);

    await runtime.close?.();
  });

  it('SEC: a pushed var.* value never reaches toPublicEnv or the browser projection', async () => {
    const runtime = await runtimeFor();
    const handler = varReceiver('svc');
    await invoke(handler, {
      method: 'POST',
      url: '/cnos/vars/push/flags',
      headers: { authorization: `Bearer ${SECRET}` },
      body: { values: { 'flags.label': 'runtime-only-value' } },
    });
    expect(runtime.read('var.flags.label')).toBe('runtime-only-value');

    expect(JSON.stringify(runtime.toPublicEnv?.() ?? {})).not.toContain('runtime-only-value');
    expect(JSON.stringify(runtime.toServerProjection())).not.toContain('runtime-only-value');
    // No var.* key can ever appear in the browser-facing public key set.
    expect(runtime.toServerProjection().publicKeys.filter((key) => key.startsWith('var.'))).toEqual([]);
    await runtime.close?.();
  });
});
