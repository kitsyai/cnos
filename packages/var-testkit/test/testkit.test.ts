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
    expect(payload.values).toEqual(DOC);
    expect(read.headers.get('etag')).toBe(created.revision);
  });
});

describe('createInMemoryVarSource', () => {
  it('serves the active head via pull and notifies subscribers on emit', async () => {
    const source = createInMemoryVarSource({ documents });
    const created = await source.engine.createRevision({ scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });
    await source.engine.activate({ scope: SCOPE, revision: created.revision, expectedGeneration: 0 });

    const batch = await source.provider.pull({ key: SCOPE });
    expect(batch.values).toEqual(DOC);
    expect(batch.generation).toBe(1);

    const received: unknown[] = [];
    const stop = source.provider.subscribe?.([{ key: SCOPE }], (next) => received.push(next.values));
    source.emit(SCOPE);
    expect(received).toEqual([DOC]);
    stop?.();

    await expect(source.provider.pull({ key: 'unmapped.scope' })).rejects.toThrow(/no active runtime head/i);
  });
});
