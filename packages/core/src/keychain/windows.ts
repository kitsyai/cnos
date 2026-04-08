import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function wrap(script: string): string[] {
  return ['-NoProfile', '-Command', script];
}

export async function readWindowsKeychain(entry: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      wrap(`Add-Type -AssemblyName System.Runtime.WindowsRuntime; [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] > $null; $vault = New-Object Windows.Security.Credentials.PasswordVault; $credential = $vault.Retrieve('cnos','${entry}'); $credential.RetrievePassword(); Write-Output $credential.Password`),
    );
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeWindowsKeychain(entry: string, value: string): Promise<void> {
  await execFileAsync(
    'powershell',
    wrap(`Add-Type -AssemblyName System.Runtime.WindowsRuntime; [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] > $null; $vault = New-Object Windows.Security.Credentials.PasswordVault; try { $existing = $vault.Retrieve('cnos','${entry}'); $vault.Remove($existing) } catch {}; $credential = New-Object Windows.Security.Credentials.PasswordCredential('cnos','${entry}','${value}'); $vault.Add($credential)`),
  );
}

export async function deleteWindowsKeychain(entry: string): Promise<void> {
  try {
    await execFileAsync(
      'powershell',
      wrap(`Add-Type -AssemblyName System.Runtime.WindowsRuntime; [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] > $null; $vault = New-Object Windows.Security.Credentials.PasswordVault; $credential = $vault.Retrieve('cnos','${entry}'); $vault.Remove($credential)`),
    );
  } catch {
    // ignore
  }
}
