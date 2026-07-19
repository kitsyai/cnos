import type {
  DocumentSchemaDefinition,
  VarScope,
  VarSnapshotBatch,
  VarSourceProvider,
} from '@kitsy/cnos-core';
import {
  createVarEngine,
  memoryStore,
  serveVarServer,
  type ScopeHead,
  type VarAuthorize,
  type VarEngine,
  type VarStore,
} from '@kitsy/cnos-var-server';

function scopeKey(scope: VarScope): string {
  const key = scope.key ?? scope.group;

  if (!key) {
    throw new Error('VarScope must specify either a key or a group.');
  }

  return key;
}

function toBatch(head: ScopeHead): VarSnapshotBatch {
  return {
    generation: head.generation,
    revision: head.revision,
    ...(head.schemaId !== undefined ? { schemaId: head.schemaId } : {}),
    effectiveAt: head.effectiveAt,
    values: head.values,
  };
}

export interface TestVarServerOptions {
  /** Store to back the server; defaults to a fresh ephemeral {@link memoryStore}. */
  store?: VarStore;
  /** Document schemas for revision validation, keyed by schemaId. */
  documents?: Record<string, DocumentSchemaDefinition>;
  /** Deterministic clock (ISO timestamps). */
  clock?: () => string;
  /** Authorization hook; defaults to allow-all. */
  authorize?: VarAuthorize;
  host?: string;
  port?: number;
}

export interface TestVarServer {
  /** Base URL including the `/cnos/vars` mount, e.g. `http://127.0.0.1:53211/cnos/vars`. */
  url: string;
  store: VarStore;
  /** Engine sharing the server's store — drive create/activate/rollback directly in tests. */
  engine: VarEngine;
  close(): Promise<void>;
}

/**
 * Start an ephemeral CNOS var server on a random free port, backed by an in-memory store.
 * The returned `engine` shares the server's store so tests can seed revisions and activate
 * them, then exercise the SDK against `url`. W3/W4 build against this.
 */
export async function startTestVarServer(options: TestVarServerOptions = {}): Promise<TestVarServer> {
  const store = options.store ?? memoryStore();
  const engine = createVarEngine(store, {
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });

  const running = await serveVarServer(store, {
    engine,
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.authorize ? { authorize: options.authorize } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  });

  return {
    url: running.url,
    store,
    engine,
    close: () => running.close(),
  };
}

export interface InMemoryVarSource {
  provider: VarSourceProvider;
  store: VarStore;
  engine: VarEngine;
  /** Push the current head batch for a scope to all active subscribers. */
  emit(scope: string): void;
}

/**
 * A transport-free {@link VarSourceProvider} double backed by an in-memory store/engine.
 * Lets consumer SDK tests exercise pull/subscribe/close without a network hop.
 */
export function createInMemoryVarSource(options: { documents?: Record<string, DocumentSchemaDefinition> } = {}): InMemoryVarSource {
  const store = memoryStore();
  const engine = createVarEngine(store, { ...(options.documents ? { documents: options.documents } : {}) });
  const subscribers = new Set<(batch: VarSnapshotBatch) => void>();

  const provider: VarSourceProvider = {
    async pull(scope: VarScope, knownRevision?: string): Promise<VarSnapshotBatch> {
      const head = store.head(scopeKey(scope));

      if (!head) {
        throw new Error(`No active runtime head for var scope "${scopeKey(scope)}".`);
      }

      if (knownRevision !== undefined && knownRevision === head.revision) {
        return toBatch(head);
      }

      return toBatch(head);
    },
    subscribe(_scopes: VarScope[], onBatch: (batch: VarSnapshotBatch) => void): () => void {
      subscribers.add(onBatch);
      return () => subscribers.delete(onBatch);
    },
    async close(): Promise<void> {
      subscribers.clear();
    },
  };

  return {
    provider,
    store,
    engine,
    emit(scope: string): void {
      const head = store.head(scope);

      if (!head) {
        return;
      }

      const batch = toBatch(head);

      for (const listener of subscribers) {
        listener(batch);
      }
    },
  };
}
