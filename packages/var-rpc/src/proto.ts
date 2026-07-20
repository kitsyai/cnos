import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

/**
 * Directory of this module, resolved for BOTH module formats: `import.meta.url` in ESM, and
 * the CJS `__dirname` global when esbuild has emptied `import.meta.url` in the cjs bundle.
 */
function moduleDir(): string {
  try {
    const url = import.meta.url;

    if (url) {
      return fileURLToPath(new URL('.', url));
    }
  } catch {
    /* fall through to the CJS branch */
  }

  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

/**
 * Absolute path to the canonical, checked-in proto — the single source of truth referenced
 * by BOTH the TypeScript and Go sides. `proto/` and `dist/` (or `src/` under vitest) are
 * siblings under the package root, so `../proto/...` resolves identically in every build.
 */
export const VAR_PROTO_PATH = path.resolve(moduleDir(), '../proto/cnos/var/v1/var.proto');

/**
 * proto-loader options, pinned deliberately (asserted by a test):
 * - `keepCase: true` keeps wire field names snake_case (`known_revision`, `values_json`,
 *   `schema_id`, `effective_at`, `not_modified`, `no_head`) exactly as authored;
 * - `longs: String` decodes the `int64 generation` as a decimal string — the client
 *   converts it to a JS number once, at the edge.
 */
export const VAR_PROTO_LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

export interface VarProtoGrpcObject {
  cnos: {
    var: {
      v1: {
        VarService: grpc.ServiceClientConstructor;
      };
    };
  };
}

let cached: VarProtoGrpcObject | undefined;

/** Load (and memoize) the `cnos.var.v1` gRPC object from the canonical proto. */
export function loadVarProto(): VarProtoGrpcObject {
  if (!cached) {
    const packageDefinition = protoLoader.loadSync(VAR_PROTO_PATH, VAR_PROTO_LOADER_OPTIONS);
    cached = grpc.loadPackageDefinition(packageDefinition) as unknown as VarProtoGrpcObject;
  }

  return cached;
}

/** The service definition used to register the server implementation. */
export function varServiceDefinition(): grpc.ServiceDefinition {
  return loadVarProto().cnos.var.v1.VarService.service;
}

/** The client constructor used to build a channel to a var rpc server. */
export function varServiceClientConstructor(): grpc.ServiceClientConstructor {
  return loadVarProto().cnos.var.v1.VarService;
}

/** The over-the-wire message shapes (snake_case, per `keepCase: true`). */
export interface WirePullRequest {
  scope: string;
  known_revision: string;
}

export interface WireSubscribeRequest {
  scopes: string[];
}

export interface WireSnapshotBatch {
  scope: string;
  generation: string | number;
  revision: string;
  schema_id: string;
  effective_at: string;
  values_json: Buffer | Uint8Array;
  not_modified: boolean;
  no_head: boolean;
}
