import readline from 'node:readline';
import { Writable } from 'node:stream';

export async function promptHidden(message: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const mutableStdout = new WritableMask();
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true,
  });

  try {
    mutableStdout.muted = true;
    const value = await new Promise<string>((resolve) => {
      rl.question(message, resolve);
    });
    process.stdout.write('\n');
    return value;
  } finally {
    rl.close();
  }
}

class WritableMask extends Writable {
  muted = false;

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      process.stdout.write(chunk);
    }

    callback();
  }
}
