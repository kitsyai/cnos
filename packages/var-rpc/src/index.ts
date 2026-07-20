export {
  createRpcVarProvider,
  rpcVarSourceProvider,
} from './client.js';
export {
  attachVarRpc,
  serveVarRpc,
  type VarRpcServerOptions,
  type ServeVarRpcOptions,
  type RunningVarRpcServer,
} from './server.js';
export {
  VAR_PROTO_PATH,
  VAR_PROTO_LOADER_OPTIONS,
  loadVarProto,
  varServiceDefinition,
  varServiceClientConstructor,
  type WirePullRequest,
  type WireSubscribeRequest,
  type WireSnapshotBatch,
} from './proto.js';
