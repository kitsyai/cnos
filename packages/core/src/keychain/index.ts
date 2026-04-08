import { CnosAuthenticationError } from '../errors.js';
import { deleteLinuxKeychain, readLinuxKeychain, writeLinuxKeychain } from './linux.js';
import { deleteMacosKeychain, readMacosKeychain, writeMacosKeychain } from './macos.js';
import { deleteWindowsKeychain, readWindowsKeychain, writeWindowsKeychain } from './windows.js';

export async function readKeychain(entry: string): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return readWindowsKeychain(entry);
  }

  if (process.platform === 'darwin') {
    return readMacosKeychain(entry);
  }

  if (process.platform === 'linux') {
    return readLinuxKeychain(entry);
  }

  return undefined;
}

export async function writeKeychain(entry: string, value: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeWindowsKeychain(entry, value);
    return;
  }

  if (process.platform === 'darwin') {
    await writeMacosKeychain(entry, value);
    return;
  }

  if (process.platform === 'linux') {
    await writeLinuxKeychain(entry, value);
    return;
  }

  throw new CnosAuthenticationError(`OS keychain is not supported on platform "${process.platform}".`);
}

export async function deleteKeychain(entry: string): Promise<void> {
  if (process.platform === 'win32') {
    await deleteWindowsKeychain(entry);
    return;
  }

  if (process.platform === 'darwin') {
    await deleteMacosKeychain(entry);
    return;
  }

  if (process.platform === 'linux') {
    await deleteLinuxKeychain(entry);
  }
}
