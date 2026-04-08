import type { CnosRuntime } from '@kitsy/cnos-core';

let singletonRuntime: CnosRuntime | undefined;
let singletonReady: Promise<CnosRuntime> | undefined;
let bootstrappedSecretHydrationRequired = false;

export function getSingletonRuntime(): CnosRuntime | undefined {
  return singletonRuntime;
}

export function setSingletonRuntime(runtime: CnosRuntime): CnosRuntime {
  singletonRuntime = runtime;
  singletonReady = Promise.resolve(runtime);
  bootstrappedSecretHydrationRequired = false;
  return runtime;
}

export function getSingletonReady(): Promise<CnosRuntime> | undefined {
  return singletonReady;
}

export function setSingletonReady(promise: Promise<CnosRuntime>): Promise<CnosRuntime> {
  singletonReady = promise;
  return promise;
}

export function getBootstrappedSecretHydrationRequired(): boolean {
  return bootstrappedSecretHydrationRequired;
}

export function setBootstrappedSecretHydrationRequired(value: boolean): void {
  bootstrappedSecretHydrationRequired = value;
}
