import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BaseVarStore } from './baseStore.js';
import type { VarEvent, VarStore } from './types.js';

function parseLog(raw: string, filePath: string): VarEvent[] {
  const events: VarEvent[] = [];
  const lines = raw.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();

    if (!line) {
      continue;
    }

    try {
      events.push(JSON.parse(line) as VarEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Corrupt var log at ${filePath}:${index + 1} — could not parse JSONL event (${message}). The log is append-only; do not hand-edit it.`,
      );
    }
  }

  return events;
}

class FileVarStore extends BaseVarStore {
  readonly persistent = true;

  /** Serializes appends so log lines never interleave and state folds in write order. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    super();
    mkdirSync(path.dirname(filePath), { recursive: true });

    if (existsSync(filePath)) {
      this.hydrate(parseLog(readFileSync(filePath, 'utf8'), filePath));
    }
  }

  protected async persist(event: VarEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const write = this.writeQueue.then(() => appendFile(this.filePath, line, 'utf8'));
    // Keep the chain alive even if a write rejects, so later appends are not blocked forever.
    this.writeQueue = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }
}

/**
 * Append-only, event-sourced JSONL var store. On construction the log is replayed to
 * resume state (restart recovery). Every mutation is an event appended forever — rollback
 * activates a prior revision as a new generation; the log is never rewritten. The log
 * carries `var.*` documents and opaque `secret.*` refs only, never secret material.
 */
export function fileStore(filePath: string): VarStore {
  return new FileVarStore(path.resolve(filePath));
}
