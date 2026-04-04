import packageJson from '../../package.json';

export function runVersion(): string {
  return packageJson.version;
}
