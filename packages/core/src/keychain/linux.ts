import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readLinuxKeychain(entry: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', 'cnos', 'account', entry]);
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLinuxKeychain(entry: string, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('secret-tool', ['store', '--label', `CNOS ${entry}`, 'service', 'cnos', 'account', entry], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stdin?.end(value);
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `secret-tool exited with code ${code ?? 1}`));
    });
  });
}

export async function deleteLinuxKeychain(entry: string): Promise<void> {
  try {
    await execFileAsync('secret-tool', ['clear', 'service', 'cnos', 'account', entry]);
  } catch {
    // ignore
  }
}
