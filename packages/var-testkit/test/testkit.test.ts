import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';
import { afterEach, describe, expect, it } from 'vitest';

import { createInMemoryVarSource, startTestVarServer, type TestVarServer } from '../src/index.js';

const SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
  },
  additionalProperties: false,
};

const documents = { 'agentic-lanes/v1': SCHEMA };
const SCOPE = 'agentic.lanes.vinci';
const DOC = { enabled: true, model_target_ref: 'secret.ops.model' };

let server: TestVarServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startTestVarServer', () => {
  it('starts an ephemeral server whose engine drives activations visible over http', async () => {
    server = await startTestVarServer({ documents });
    const created = await server.engine.createRevision({ scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });
    await server.engine.activate({ scope: SCOPE, revision: created.revision, expectedGeneration: 0 });

    const read = await fetch(`${server.url}?key=${SCOPE}`);
    expect(read.status).toBe(200);
    const payload = await read.json();
    // Canonical: key-scoped `values` is keyed by the full var key.
    expect(payload.values).toEqual({ [SCOPE]: DOC });
    expect(read.headers.get('etag')).toBe(created.revision);
  });
});

describe('createInMemoryVarSource', () => {
  it('serves the active head via pull and notifies subscribers on emit', async () => {
    const source = createInMemoryVarSource({ documents });
    const created = await source.engine.createRevision({ scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });
    await source.engine.activate({ scope: SCOPE, revision: created.revision, expectedGeneration: 0 });

    const batch = await source.provider.pull({ key: SCOPE });
    expect(batch.values).toEqual({ [SCOPE]: DOC });
    expect(batch.generation).toBe(1);

    const received: unknown[] = [];
    const events: string[] = [];
    const stop = source.provider.subscribe?.([{ key: SCOPE }], (event) => {
      events.push(event.kind);
      if (event.batch) {
        received.push(event.batch.values);
      }
    });
    source.emit(SCOPE);
    expect(received).toEqual([{ [SCOPE]: DOC }]);
    expect(events).toEqual(['batch']);

    // Deactivation: the double emits the same `no-head` DEACTIVATION event the rpc server
    // pushes, so SDK tests can drive an activate -> deactivate -> fallback cycle transport-free.
    await source.engine.deactivate({ scope: SCOPE, expectedGeneration: 1 });
    source.emit(SCOPE);
    expect(events).toEqual(['batch', 'no-head']);
    expect(received).toHaveLength(1);
    stop?.();

    await expect(source.provider.pull({ key: 'unmapped.scope' })).rejects.toThrow(/no active runtime head/i);
  });
});
