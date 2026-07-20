import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import protoLoader from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import { VAR_PROTO_PATH, VAR_PROTO_LOADER_OPTIONS } from '../src/index.js';

/**
 * Byte-level cross-toolchain fixtures for the rpc wire format. Its twin is
 * `packages/go/varrpc/wire_test.go`; both read the SAME blobs under
 * `fixtures/var-cross-sdk/rpc/`. The Go submodule hand-writes the protobuf wire format
 * (protoc is not a build prerequisite), so these fixtures are what guarantees the two
 * encoders stay byte-identical. If the wire shape changes, both tests move together.
 */
const FIXTURES = path.resolve(fileURLToPath(import.meta.url), '../../../../fixtures/var-cross-sdk/rpc');

interface FixtureEntry {
  file: string;
  message: 'PullRequest' | 'SubscribeRequest' | 'SnapshotBatch';
  decodeOnly?: boolean;
  hex: string;
  value: Record<string, unknown>;
}

const manifest = JSON.parse(readFileSync(path.join(FIXTURES, 'messages.json'), 'utf8')) as FixtureEntry[];

const packageDefinition = protoLoader.loadSync(VAR_PROTO_PATH, VAR_PROTO_LOADER_OPTIONS);
const service = packageDefinition['cnos.var.v1.VarService'] as unknown as {
  Pull: {
    requestSerialize: (value: unknown) => Buffer;
    requestDeserialize: (bytes: Buffer) => Record<string, unknown>;
    responseSerialize: (value: unknown) => Buffer;
    responseDeserialize: (bytes: Buffer) => Record<string, unknown>;
  };
  Subscribe: {
    requestSerialize: (value: unknown) => Buffer;
    requestDeserialize: (bytes: Buffer) => Record<string, unknown>;
  };
};

/** Rebuild the wire object for a fixture, omitting proto3 defaults (the canonical form). */
function toWireValue(entry: FixtureEntry): Record<string, unknown> {
  const value: Record<string, unknown> = { ...entry.value };
  const valuesJsonUtf8 = value.values_json_utf8;
  delete value.values_json_utf8;

  if (typeof valuesJsonUtf8 === 'string' && valuesJsonUtf8.length > 0) {
    value.values_json = Buffer.from(valuesJsonUtf8, 'utf8');
  }

  return value;
}

function serializerFor(entry: FixtureEntry): (value: unknown) => Buffer {
  if (entry.message === 'PullRequest') {
    return service.Pull.requestSerialize;
  }
  if (entry.message === 'SubscribeRequest') {
    return service.Subscribe.requestSerialize;
  }
  return service.Pull.responseSerialize;
}

function deserializerFor(entry: FixtureEntry): (bytes: Buffer) => Record<string, unknown> {
  if (entry.message === 'PullRequest') {
    return service.Pull.requestDeserialize;
  }
  if (entry.message === 'SubscribeRequest') {
    return service.Subscribe.requestDeserialize;
  }
  return service.Pull.responseDeserialize;
}

describe('rpc cross-toolchain wire fixtures', () => {
  it('has a non-empty fixture manifest', () => {
    expect(manifest.length).toBeGreaterThan(0);
  });

  for (const entry of manifest) {
    describe(entry.file, () => {
      const bytes = readFileSync(path.join(FIXTURES, entry.file));

      it('blob matches its manifest hex', () => {
        expect(bytes.toString('hex')).toBe(entry.hex);
      });

      if (!entry.decodeOnly) {
        it('Node encodes byte-identically to the checked-in blob (Go asserts the same)', () => {
          const encoded = Buffer.from(serializerFor(entry)(toWireValue(entry)));
          expect(encoded.toString('hex')).toBe(entry.hex);
        });
      }

      it('Node decodes the blob to the expected logical fields', () => {
        const decoded = deserializerFor(entry)(bytes);

        for (const [key, expected] of Object.entries(entry.value)) {
          if (key === 'values_json_utf8') {
            expect(Buffer.from(decoded.values_json as Buffer).toString('utf8')).toBe(expected);
            continue;
          }

          expect(decoded[key]).toEqual(expected);
        }
      });
    });
  }

  it('the explicit-defaults blob (what the TS server emits) decodes to the canonical no-head message', () => {
    const canonical = service.Pull.responseDeserialize(readFileSync(path.join(FIXTURES, 'snapshot-batch-no-head.bin')));
    const explicit = service.Pull.responseDeserialize(
      readFileSync(path.join(FIXTURES, 'snapshot-batch-explicit-defaults.bin')),
    );

    expect(explicit.scope).toBe(canonical.scope);
    expect(explicit.no_head).toBe(canonical.no_head);
    expect(explicit.generation).toBe(canonical.generation);
    expect(explicit.revision).toBe(canonical.revision);
    expect(explicit.not_modified).toBe(canonical.not_modified);
  });
});
