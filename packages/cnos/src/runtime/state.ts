import type { CnosRuntime } from '@kitsy/cnos-core';

let singletonRuntime: CnosRuntime | undefined;
let singletonReady: Promise<CnosRuntime> | undefined;

export function getSingletonRuntime(): CnosRuntime | undefined {
  return singletonRuntime;
}

export function setSingletonRuntime(runtime: CnosRuntime): CnosRuntime {
  singletonRuntime = runtime;
  singletonReady = Promise.resolve(runtime);
  return runtime;
}

export function getSingletonReady(): Promise<CnosRuntime> | undefined {
  return singletonReady;
}

export function setSingletonReady(promise: Promise<CnosRuntime>): Promise<CnosRuntime> {
  singletonReady = promise;
  return promise;
}
