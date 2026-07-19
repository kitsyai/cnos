export { default, default as cnos } from './runtime/index.js';
export type { CnosSingleton, CnosSingletonProjectionOptions } from './runtime/index.js';
export type {
  ConfigEntry,
  DerivedFormula,
  DerivedValue,
  ExprNode,
  InspectResult,
  LoaderPlugin,
  LogicalKey,
  ParsedDerivation,
  CnosPlugin,
  CnosRuntime,
  ManifestFile,
  NormalizedManifest,
  RuntimeProvider,
  RemoteSecretVaultProvider,
  SecretVaultProvider,
  SecretVaultProviderFactory,
  VaultAuthConfig,
  VaultDefinition,
} from '@kitsy/cnos-core';
export type {
  ResolvedVarSnapshot,
  VarScopeStatus,
  VarStatusReport,
  VarWatchCallback,
  VarSourceProvider,
  VarSourceProviderModule,
  VarSnapshotBatch,
} from '@kitsy/cnos-core';

export { varReceiver, type VarReceiverHandler, type VarReceiverOptions } from './varReceiver.js';
export { defaultVarSourceProviders } from './defaultVarSourceProviders.js';
export { httpVarSourceProvider } from '@kitsy/cnos-var-http';
