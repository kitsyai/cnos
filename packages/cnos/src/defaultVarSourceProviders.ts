import type { VarSourceProviderModule } from '@kitsy/cnos-core';
import { httpVarSourceProvider } from '@kitsy/cnos-var-http';

/**
 * The var source provider modules auto-registered by the batteries-included package.
 * Mirrors {@link defaultPlugins} — the http transport ships enabled by default.
 *
 * The rpc transport is deliberately NOT auto-registered: it pulls in `@grpc/grpc-js`, and
 * `@kitsy/cnos` must not force that dependency on every consumer. Apps that use an rpc var
 * source opt in explicitly, exactly like an official plugin:
 *
 * ```ts
 * import { rpcVarSourceProvider } from '@kitsy/cnos-var-rpc';
 * await createCnos({ varSourceProviders: [rpcVarSourceProvider] });
 * ```
 *
 * ws/sse modules follow the same opt-in pattern when they ship.
 */
export function defaultVarSourceProviders(): VarSourceProviderModule[] {
  return [httpVarSourceProvider];
}
