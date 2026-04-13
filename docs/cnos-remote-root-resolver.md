# CNOS — Remote Root Resolver

**Status:** Implementation-ready.
**Scope:** `cnos` repo. Adds remote root resolution to the existing anchor-based discovery module.

---

## 1. What This Adds

The `.cnosrc.yml` `root` field today accepts local filesystem paths. This spec extends it to accept remote URIs. The resolution pipeline downloads/clones the remote config into a local cache, then uses the cached directory as the root — identically to how a local path works.

```yaml
# Local (existing)
root: ./.cnos

# Local monorepo (existing)
root: ../../.cnos
workspace: travel

# Git remote (new)
root: git+https://github.com/prashant/config.git#v2.1.0
workspace: travel

# Shiva hosted secret store (future, via vault provider — not a root)
# Secrets are accessed through the vault provider, not through root resolution.

# CNOS hosted (future — when cnos.kitsy.ai ships)
root: cnos://kitsy.ai/prashant/my-service@v2.1.0
workspace: travel
```

The key insight: **root resolution is protocol-agnostic.** The discovery module resolves any URI to a local directory path, then the rest of the pipeline runs unchanged. Adding a new protocol (git, cnos, s3, whatever) is adding one resolver function.

---

## 2. URI Formats

### 2.1 Git remote

```
git+https://github.com/org/config-repo.git#<ref>[:<subpath>]
git+ssh://git@github.com/org/config-repo.git#<ref>[:<subpath>]
```

| Component | Required | Description |
|-----------|----------|-------------|
| Protocol | Yes | `git+https://` or `git+ssh://` |
| URL | Yes | Git clone URL |
| `#<ref>` | Yes in production | Git ref: tag, branch, or commit SHA |
| `:<subpath>` | No | Path within the repo to the `.cnos/` directory. Default: `.cnos` at repo root |

Examples:

```yaml
# Tag-pinned (recommended for production)
root: git+https://github.com/prashant/config.git#v2.1.0

# Branch (for development — re-fetches on TTL)
root: git+https://github.com/prashant/config.git#main

# Commit SHA (immutable)
root: git+https://github.com/prashant/config.git#a1b2c3d

# Subpath (config lives in a subdirectory of the repo)
root: git+https://github.com/prashant/monorepo.git#v2.1.0:.cnos

# SSH (for private repos)
root: git+ssh://git@github.com/prashant/config-private.git#v2.1.0
```

**Why `git+https://` not `git://`:** The `git://` protocol is unauthenticated and unencrypted. GitHub deprecated it in 2022. `git+https://` makes the transport protocol explicit and matches the convention used by npm, pip, and Go modules for git dependencies.

### 2.2 CNOS hosted (future)

```
cnos://kitsy.ai/<org>/<project>@<version>
```

This protocol is reserved but not implemented. When `cnos.kitsy.ai` ships as a hosted service, a resolver for `cnos://` will be added. The resolver will fetch the config tree from the CNOS API, cache it locally, and return the cache path — same pattern as git.

**Migration from git to hosted is one line:**

```yaml
# Before
root: git+https://github.com/prashant/config.git#v2.1.0

# After
root: cnos://kitsy.ai/prashant/my-service@v2.1.0
```

No code change, no manifest change, no workflow change.

---

## 3. Resolution Pipeline

### 3.1 Root resolver chain

```ts
async function resolveRoot(rootUri: string, cnosrcDir: string): Promise<string> {
  // 1. Detect protocol
  if (rootUri.startsWith("./") || rootUri.startsWith("../") || rootUri.startsWith("/")) {
    return resolveLocalRoot(rootUri, cnosrcDir);
  }
  if (rootUri.startsWith("git+https://") || rootUri.startsWith("git+ssh://")) {
    return resolveGitRoot(rootUri);
  }
  if (rootUri.startsWith("cnos://")) {
    return resolveCnosHostedRoot(rootUri);  // future
  }
  throw new CnosDiscoveryError(`Unknown root protocol: ${rootUri}`);
}
```

### 3.2 Local root resolver (existing, unchanged)

```ts
function resolveLocalRoot(rootUri: string, cnosrcDir: string): string {
  const resolved = resolve(cnosrcDir, rootUri);
  if (!existsSync(join(resolved, "cnos.yml"))) {
    throw new CnosDiscoveryError(`No cnos.yml found at ${resolved}`);
  }
  return resolved;
}
```

### 3.3 Git root resolver

```ts
async function resolveGitRoot(uri: string): Promise<string> {
  const parsed = parseGitUri(uri);
  // parsed: { cloneUrl, ref, subpath }

  const cacheKey = sha256(uri);
  const cacheDir = join(CNOS_CACHE_DIR, "roots", cacheKey);
  const metaFile = join(cacheDir, ".cnos-cache-meta.json");

  // Check cache freshness
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    if (isCacheFresh(meta, parsed)) {
      return join(cacheDir, "repo", parsed.subpath);
    }
  }

  // Clone or fetch
  await gitCloneOrFetch(parsed.cloneUrl, parsed.ref, join(cacheDir, "repo"));

  // Write cache metadata
  writeFileSync(metaFile, JSON.stringify({
    uri,
    cloneUrl: parsed.cloneUrl,
    ref: parsed.ref,
    subpath: parsed.subpath,
    resolvedCommit: await getResolvedCommit(join(cacheDir, "repo")),
    cachedAt: new Date().toISOString(),
    isImmutable: isImmutableRef(parsed.ref),
  }));

  const rootPath = join(cacheDir, "repo", parsed.subpath);
  if (!existsSync(join(rootPath, "cnos.yml"))) {
    throw new CnosDiscoveryError(
      `Git repo cloned but no cnos.yml found at subpath "${parsed.subpath}". ` +
      `Check the :subpath component of your root URI.`
    );
  }

  return rootPath;
}
```

### 3.4 Git URI parser

```ts
interface ParsedGitUri {
  cloneUrl: string;     // https://github.com/org/repo.git
  ref: string;          // v2.1.0, main, a1b2c3d
  subpath: string;      // .cnos (default) or custom
  protocol: "https" | "ssh";
}

function parseGitUri(uri: string): ParsedGitUri {
  // git+https://github.com/org/repo.git#v2.1.0:.cnos
  // git+ssh://git@github.com/org/repo.git#main

  const withoutProtocol = uri.replace(/^git\+/, "");
  const [urlPart, fragment] = withoutProtocol.split("#");

  if (!fragment) {
    throw new CnosDiscoveryError(
      `Git root URI must include a #ref (tag, branch, or commit). Got: ${uri}`
    );
  }

  const [ref, subpath] = fragment.split(":");

  return {
    cloneUrl: urlPart,
    ref,
    subpath: subpath || ".cnos",
    protocol: urlPart.startsWith("ssh://") ? "ssh" : "https",
  };
}
```

---

## 4. Cache Model

### 4.1 Cache directory structure

```
~/.cnos/cache/
  roots/
    <sha256-of-uri>/
      .cnos-cache-meta.json     # freshness metadata
      repo/                     # cloned repo content
        .cnos/
          cnos.yml
          workspaces/
          ...
```

### 4.2 Freshness rules

| Ref type | Detection | Caching behavior |
|----------|-----------|-----------------|
| Semantic version tag (`v2.1.0`, `v1.0.0-rc.1`) | Matches `/^v?\d+\.\d+/` | **Immutable.** Cached permanently. Never re-fetched. |
| Commit SHA (40 hex chars) | Matches `/^[0-9a-f]{40}$/` | **Immutable.** Cached permanently. |
| Branch (`main`, `develop`, `feature/x`) | Everything else | **Mutable.** Re-fetched when stale. |

For mutable refs, staleness is determined by TTL:

| Context | Default TTL | Configurable |
|---------|-------------|-------------|
| `createCnos()` runtime | 5 minutes | `CNOS_CACHE_TTL` env var (seconds) |
| `cnos build` | Always re-fetch | Not configurable — build must be fresh |
| `cnos run` | 5 minutes | Same as runtime |
| `cnos dev` / `cnos watch` | 30 seconds | `--cache-ttl` flag |

### 4.3 Cache management CLI

```bash
# List cached remote roots
cnos cache list
# Output:
#   git+https://github.com/prashant/config.git#v2.1.0
#     cached: 2026-04-11T10:00:00Z
#     commit: a1b2c3d4e5f6
#     immutable: yes
#     size: 24 KB
#
#   git+https://github.com/prashant/config.git#main
#     cached: 2026-04-11T14:30:00Z
#     commit: f6e5d4c3b2a1
#     immutable: no (TTL: 5m, expires in 2m)
#     size: 24 KB

# Clear all cached roots
cnos cache clear

# Clear specific cached root
cnos cache clear git+https://github.com/prashant/config.git#v2.1.0

# Force re-fetch a mutable root
cnos cache refresh
cnos cache refresh git+https://github.com/prashant/config.git#main
```

### 4.4 Authentication for private repos

Git authentication uses the ambient git credential configuration. CNOS does not implement its own git auth — it delegates to `git clone` / `git fetch` which uses the system's credential helpers (SSH keys, `~/.netrc`, git credential manager, `GIT_ASKPASS`).

For `git+https://` with private repos:

```bash
# Option 1: Git credential helper (recommended)
# Already configured if the user can `git clone` the repo

# Option 2: Token in environment (CI/CD)
export GIT_TOKEN=ghp_xxxx
# .cnosrc.yml uses https:// — git uses GIT_ASKPASS or .netrc

# Option 3: SSH key (most common for developers)
root: git+ssh://git@github.com/org/private-config.git#v2.1.0
```

CNOS does NOT support embedding tokens in the URI (`https://token@github.com/...`). This would put credentials in `.cnosrc.yml` which may be committed. Instead, rely on git's native credential mechanisms.

---

## 5. Read-Only Remote Roots

Remote roots are **read-only** by default. `cnos define`, `cnos promote`, and `cnos vault` commands that write to the config root are blocked when the root is remote.

```bash
cnos define value server.port 3000
# Error: Cannot write to remote root. Config is read-only when loaded from git+https://...
# To make changes, clone the config repo and edit directly.
```

This is the correct behavior because:
- Writing to a cached git clone doesn't push changes upstream.
- The config repo has its own git workflow (PR, review, merge).
- CNOS is a consumer of the remote config, not an editor.

Exception: `cnos define` with `--local-override` (future consideration) could write to a local overlay file that takes precedence over the remote root. This is not in scope for this spec.

---

## 6. Doctor Checks for Remote Roots

```bash
cnos doctor
# Remote roots:
#   ✓ git+https://github.com/prashant/config.git#v2.1.0
#     cached: yes, immutable, commit: a1b2c3d
#   ⚠ git+https://github.com/prashant/config.git#main
#     cached: yes, mutable, last fetch: 3 minutes ago
#     WARNING: Using mutable branch ref. Pin to a tag for production.
#   ✗ git+https://github.com/prashant/missing-repo.git#v1.0.0
#     ERROR: Clone failed. Check URL and credentials.
```

---

## 7. Module Layout

### New files

```
packages/cnos/src/
  discovery/
    resolveRoot.ts              # protocol detection + resolver chain
    resolvers/
      local.ts                  # existing local path resolver (extracted)
      git.ts                    # git clone/fetch/cache
      cnos.ts                   # future cnos:// resolver (stub)
    parseGitUri.ts              # URI parser
    cache/
      cacheManager.ts           # freshness checks, TTL, immutability detection
      cachePaths.ts             # ~/.cnos/cache/ path construction
      cacheMetadata.ts          # read/write .cnos-cache-meta.json

packages/cli/src/
  commands/
    cache.ts                    # cnos cache list|clear|refresh
```

### Updated files

```
packages/cnos/src/
  discovery/
    findCnosrc.ts               # UPDATED: pass root URI to resolveRoot()
```

---

## 8. Test Plan

### URI parsing

- [ ] GIT-1: `git+https://github.com/org/repo.git#v2.1.0` parsed correctly.
- [ ] GIT-2: `git+ssh://git@github.com/org/repo.git#main` parsed correctly.
- [ ] GIT-3: `git+https://...#v2.1.0:.cnos` extracts subpath `.cnos`.
- [ ] GIT-4: Missing `#ref` → error with actionable message.
- [ ] GIT-5: Unknown protocol → error listing supported protocols.
- [ ] GIT-6: Local path still works unchanged.

### Cache behavior

- [ ] CACHE-1: First fetch clones repo and writes cache metadata.
- [ ] CACHE-2: Immutable ref (tag) → second access uses cache, no network.
- [ ] CACHE-3: Commit SHA → immutable, cached permanently.
- [ ] CACHE-4: Branch ref → re-fetched after TTL expires.
- [ ] CACHE-5: Branch ref within TTL → cache used.
- [ ] CACHE-6: `cnos build` always re-fetches mutable refs.
- [ ] CACHE-7: `cnos cache clear` removes all cached roots.
- [ ] CACHE-8: `cnos cache list` shows correct info.
- [ ] CACHE-9: Cache directory structure matches spec.
- [ ] CACHE-10: Cache key is SHA-256 of full URI (different refs = different caches).

### Resolution

- [ ] RES-1: Remote root resolves to local cache directory.
- [ ] RES-2: `cnos.yml` found at subpath in cached repo.
- [ ] RES-3: Missing `cnos.yml` in cached repo → clear error.
- [ ] RES-4: Full pipeline works on cached remote root (loaders, resolver, projection).
- [ ] RES-5: Workspace selection from `.cnosrc.yml` works with remote root.
- [ ] RES-6: Profile resolution works with remote root.

### Write protection

- [ ] WP-1: `cnos define` on remote root → error.
- [ ] WP-2: `cnos promote` on remote root → error.
- [ ] WP-3: `cnos build` (read-only) on remote root → works.
- [ ] WP-4: `cnos export` on remote root → works.
- [ ] WP-5: `cnos run` on remote root → works.

### Doctor

- [ ] DOC-R-1: Valid cached remote root → ✓.
- [ ] DOC-R-2: Mutable branch ref → warning about pinning.
- [ ] DOC-R-3: Unreachable remote → error with URL.

### Private repos

- [ ] AUTH-R-1: SSH key auth works for `git+ssh://`.
- [ ] AUTH-R-2: Git credential helper works for `git+https://` private repo.
- [ ] AUTH-R-3: Missing credentials → clear error mentioning git credential setup.

---

## 9. Future: CNOS Hosted Protocol

When `cnos.kitsy.ai` ships, the `cnos://` resolver will:

1. Authenticate via API key or OAuth token (stored in `~/.cnos/auth/kitsy.yml` or env var `CNOS_API_KEY`).
2. Fetch the config tree for the specified org/project/version from the CNOS API.
3. Cache locally using the same cache model as git.
4. Return the cache path.

The API contract:

```
GET https://cnos.kitsy.ai/api/v1/config/{org}/{project}/{version}
Authorization: Bearer <token>
Accept: application/tar+gzip

Response: tar.gz of the .cnos/ directory tree
```

The resolver downloads, extracts to cache, and returns the path. Same as git — different transport.

The hosted service adds value beyond what git provides:
- Web UI for editing config
- Role-based access control per workspace
- Audit log of all changes
- Environment promotion workflows (stage → prod with approval gate)
- Webhook on config change (notify deployments to refresh)
- Dashboard: which deployments run which config version
- Diff between versions
- Rollback to previous version

This is the premium offering. The git protocol remains the free/OSS path.
