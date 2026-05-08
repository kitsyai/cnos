# Monorepo Runtime Projection Reference

Full spec: see `cnos-monorepo-projection.md` in project docs.

## Anchor-Based Discovery

Every package using CNOS must have `.cnosrc.yml`:
```yaml
root: ../../.cnos        # path to config root (relative to this file)
workspace: travel        # workspace within that root
```

Discovery: bounded search for `.cnosrc.yml` up to 3 levels from cwd. NOT a filesystem-root walk. No `.cnosrc.yml` found → error with actionable message.

If `root` is provided in `createCnos()` options, discovery is skipped entirely.

## Server Projection Shape

```ts
interface ServerProjection {
  version: 1;
  workspace: string;
  profile: string;
  resolvedAt: string;
  configHash: string;              // SHA-256 of sorted values
  values: Record<string, unknown>; // concrete values (value.* prefix stripped)
  derived: Record<string, DerivedFormula>; // runtime-dependent formulas
  secretRefs: Record<string, SecretRef>;   // never plaintext
  publicKeys: string[];
  runtimeNamespaces: string[];
  meta: { workspace: string; profile: string; cnos_version: string };
}
```

## Delivery Modes

1. `cnos run` → injects `__CNOS_PROJECTION__` env var into child
2. `cnos build server --to .cnos-server.json` → writes projection file
3. Full resolution from `.cnos/` directory → fallback when neither above exists

Runtime auto-discovery priority: env var → `.cnos-server.json` file → full resolution.

## Build Command

```bash
cnos build server --to .cnos-server.json
cnos build browser --to .cnos-browser.json
cnos build env --to .env.prod --format dotenv|json|shell|yaml|docker-env|toml
cnos build public --framework vite --to .env.vite
```

## Workspace Detach/Attach

`cnos workspace detach`: materializes effective workspace into standalone `.cnos/` at package root. Updates `.cnosrc.yml` to `root: ./.cnos`. Writes `.detached` marker.

`cnos workspace attach`: imports detached `.cnos/` back into parent workspace. Requires `.detached` marker. `--force` to overwrite existing workspace.
