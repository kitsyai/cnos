import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readMacosKeychain(entry: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-a', 'cnos', '-s', entry, '-w']);
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeMacosKeychain(entry: string, value: string): Promise<void> {
  await execFileAsync('security', ['add-generic-password', '-a', 'cnos', '-s', entry, '-w', value, '-U']);
}

export async function deleteMacosKeychain(entry: string): Promise<void> {
  try {
    await execFileAsync('security', ['delete-generic-password', '-a', 'cnos', '-s', entry]);
  } catch {
    // ignore
  }
}
