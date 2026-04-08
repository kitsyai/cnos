export class SecretCache {
  private readonly cache = new Map<string, string>();
  private readonly authenticated = new Set<string>();

  load(vaultId: string, secrets: Map<string, string>): void {
    this.authenticated.add(vaultId);

    for (const [ref, value] of secrets) {
      this.cache.set(`${vaultId}:${ref}`, value);
    }
  }

  isVaultAuthenticated(vaultId: string): boolean {
    return this.authenticated.has(vaultId);
  }

  get(vaultId: string, ref: string): string | undefined {
    return this.cache.get(`${vaultId}:${ref}`);
  }

  clear(vaultId?: string): void {
    if (!vaultId) {
      this.cache.clear();
      this.authenticated.clear();
      return;
    }

    this.authenticated.delete(vaultId);

    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(`${vaultId}:`)) {
        this.cache.delete(key);
      }
    }
  }
}
