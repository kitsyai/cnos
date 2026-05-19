import readline from 'node:readline';
import { Writable } from 'node:stream';

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

function assertInteractiveInput(mode: 'masked' | 'plain'): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Cannot prompt for ${mode} input in non-interactive mode.`);
  }
}

export async function promptMaskedInput(message: string): Promise<string> {
  assertInteractiveInput('masked');

  const mutableStdout = new WritableMask();
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true,
  });

  try {
    process.stdout.write(message);
    mutableStdout.muted = true;
    const value = await new Promise<string>((resolve) => {
      rl.question('', resolve);
    });
    process.stdout.write('\n');
    return value;
  } finally {
    rl.close();
  }
}

export async function promptInput(message: string): Promise<string> {
  assertInteractiveInput('plain');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    return await new Promise<string>((resolve) => {
      rl.question(message, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}
