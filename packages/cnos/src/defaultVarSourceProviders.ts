import type { VarSourceProviderModule } from '@kitsy/cnos-core';
import { httpVarSourceProvider } from '@kitsy/cnos-var-http';

/**
 * The var source provider modules auto-registered by the batteries-included package.
 * Mirrors {@link defaultPlugins} — the http transport ships enabled by default; rpc/ws/sse
 * modules are opt-in via the `varSourceProviders` create option until they ship.
 */
export function defaultVarSourceProviders(): VarSourceProviderModule[] {
  return [httpVarSourceProvider];
}
