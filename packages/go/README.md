# CNOS Go Runtime

`packages/go` is the first-party Go runtime client for CNOS runtime graph bootstraps, server projections, native authoring-time `.cnos/` resolution, and Git-backed remote roots.

It loads CNOS in this order:

- `ProjectionData` passed to `LoadProjection`
- `ProjectionPath` passed to `Load`
- `__CNOS_GRAPH__`
- `__CNOS_PROJECTION__`
- explicit `.cnos-server.json`
- autodiscovered `.cnos-server.json` next to `.cnosrc.yml`
- native `.cnos/` or `cnos/` authoring-time resolution from `Root` or a discovered `.cnosrc.yml`

That authoring-time fallback understands:

- `.cnosrc.yml` anchor discovery
- `git+https://...#ref` and `git+ssh://...#ref` remote roots from `.cnosrc.yml` or `Options.Root`
- `.cnos-workspace.yml`
- workspace inheritance and optional global roots
- profile activation and inheritance
- filesystem values and secrets
- dotenv layers
- process env mappings
- public promotion
- runtime-derived values
- manifest vault mappings for environment and local vault secrets

It reads `value.*`, `secret.*`, `public.*`, and selected `meta.*` keys, evaluates runtime-dependent derived formulas at read time, hydrates `environment`, `github-secrets`, and `local` vault refs, reuses CNOS local-vault auth from `~/.cnos/secrets/sessions/<vault>.json`, and understands encrypted `cnos run --auth` secret payloads.

Current module path:

```go
import cnos "github.com/kitsyai/cnos/packages/go"
```

Example:

```go
runtime, err := cnos.Load(cnos.Options{})
if err != nil {
	panic(err)
}

port, _, err := runtime.Value("server.port")
if err != nil {
	panic(err)
}

token, _, err := runtime.Secret("app.token")
if err != nil {
	panic(err)
}
```

For Node-style default-runtime ergonomics, you can also use the package singleton:

```go
if err := cnos.Ready(); err != nil {
	panic(err)
}

value, ok, err := cnos.Read("value.app.version")
if err != nil {
	panic(err)
}
_ = value
_ = ok
```

When bootstrapped by `cnos run` or a local `.cnos-server.json`, the package singleton auto-attaches and `Ready()` becomes optional.

Inspect/provenance works on both authoring and graph-backed runtimes:

```go
inspect, err := runtime.Inspect("value.app.version")
if err != nil {
	panic(err)
}
_ = inspect
```

Custom runtime namespaces work the same way as the Node runtime:

```go
host := ""

if err := runtime.RegisterRuntimeProvider("request", func(path string) any {
	if path == "headers.host" && host != "" {
		return host
	}
	return nil
}); err != nil {
	panic(err)
}
```

Remote vault providers are compiled into the binary by registering provider factories. The manifest still decides which named vault uses which provider:

```go
factory := cnos.SecretVaultProviderFactory{
	Provider: "gcp-secret-manager",
	Create: func(vaultID string, definition cnos.VaultDefinition) (cnos.SecretVaultProvider, error) {
		return newGCPProvider(vaultID, definition), nil
	},
}

runtime, err := cnos.Load(cnos.Options{
	SecretVaultProviders: []cnos.SecretVaultProviderFactory{factory},
})
```

Secret refs may omit `provider` when they name a configured vault. The runtime resolves projected auth refs such as `env:NAME`, `file:~/.token`, and `keychain:cnos/prod` into an in-memory `VaultAuthConfig`, calls `Authenticate`, and batches startup hydration with one `BatchGet` call per vault. Explicit vault fallbacks are supported; there is no automatic env fallback.

Built-in `process.*` reads support `env.*`, `cwd`, `platform`, `arch`, and `pid`. `process.node.version` remains Node-only and resolves only in the JavaScript runtime.

Current v1 limits:

- browser/public runtime entrypoints are not implemented in Go
