# Remote Root Resolver Reference

Full spec: see `cnos-remote-root-resolver.md` in project docs.

## URI Formats

```yaml
# Local (existing)
root: ./.cnos
root: ../../.cnos

# Git remote
root: git+https://github.com/org/config.git#v2.1.0
root: git+ssh://git@github.com/org/config.git#main
root: git+https://github.com/org/repo.git#v2.1.0:.cnos   # subpath

# CNOS hosted (future)
root: cnos://kitsy.ai/org/project@v2.1.0
```

`#ref` is mandatory. Subpath after `:` defaults to `.cnos`.

## Cache Model

Location: `~/.cnos/cache/roots/<sha256-of-uri>/`

| Ref type | Caching |
|----------|---------|
| Semantic version tag (`v2.1.0`) | Immutable, cached permanently |
| Commit SHA (40 hex) | Immutable, cached permanently |
| Branch (`main`, `develop`) | Mutable, TTL-based (5 min default) |

`cnos build` always re-fetches mutable refs. `cnos cache list/clear/refresh` manages cache.

## Remote Roots Are Read-Only

`cnos define`, `cnos promote`, and any write commands are blocked on remote roots. Config changes go through the config repo's git workflow.

## Authentication

Git auth delegated to system git config (SSH keys, credential helpers, `.netrc`). CNOS does NOT embed tokens in URIs or store git credentials.

## Future: cnos:// Protocol

When `cnos.kitsy.ai` ships, adding a `cnos://` resolver is adding one function. Migration from git to hosted: change one line in `.cnosrc.yml`.
