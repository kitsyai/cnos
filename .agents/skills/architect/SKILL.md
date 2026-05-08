# Architect Skill

You are evaluating or designing architectural changes to CNOS.

## Before Proposing Changes

1. Read `.agents/ARCHITECTURE.md` for current architecture, types, and module layout.
2. Read `.agents/context/` for existing specs — check if the area already has a design.
3. Understand the pipeline order (§Pipeline in ARCHITECTURE.md) — changes must respect stage ordering.

## Evaluation Criteria

When reviewing a proposed change, assess:

1. **Core invariant preserved?** Application code reads logical keys. CNOS decides sources and resolution. If a change requires app code to know about sources, it's wrong.

2. **Security boundaries maintained?** `secret.*` and `sensitive: true` namespaces must never reach public/browser surfaces. Promotion safety must be transitive through derived value dependencies. Secret refs in projections, never plaintext.

3. **Works across all surfaces?** Every feature must work in: server runtime, browser runtime, CLI, env export, server projection, browser projection. If a feature only works in one surface, it's incomplete.

4. **Workspace and profile orthogonality?** Workspaces compose config trees. Profiles activate environment layers. These are independent concepts. A change that conflates them is wrong.

5. **Manifest complexity?** Fewer top-level sections is better. Sensible defaults over required config. A solo developer with one service should need only `version` and `project.name` in their manifest.

6. **Caching correctness?** Config-only derived values: cached per resolution pass. Runtime-dependent derived values: never cached. Secret cache: per-runtime instance, refreshed through the runtime secret-refresh flow. Confusing these causes stale-data bugs.

7. **Determinism?** Same inputs must produce same outputs. Only runtime namespaces (`process.*`, `request.*`, etc.) are allowed to be non-deterministic. Everything else must be reproducible.

8. **Can a code agent implement it?** The spec must be precise enough for implementation without human clarification. Types must be defined. Module placement must be specified. Test plan must be included.

## Output Format

Produce:
- **Assessment:** what's strong, what needs tightening, what's missing.
- **Specific recommendations** with rationale.
- **If approved:** implementation-ready spec with types, module layout, and test plan.

## Key Architectural Decisions Already Made

Reference these when evaluating whether a new proposal conflicts:

- **Anchor-based discovery** over upward filesystem walk. `.cnosrc.yml` is the sole authority for where a package's config lives. No unbounded traversal.
- **Projection as the delivery unit.** Server and browser runtimes consume projections (flat payloads), not the full `.cnos/` tree. Production runtime should not need the authoring tree.
- **Secret refs, never plaintext, in all serialized state.** `__CNOS_PROJECTION__`, `.cnos-server.json`, and `__CNOS_BROWSER_DATA__` never contain decrypted secrets.
- **Batch secret resolution at startup.** One vault round-trip per vault at startup, zero at read time. Per-read vault calls are unacceptable for production.
- **`base` is conventional, not hardcoded.** The resolver does not special-case the workspace name `base`. It's a scaffold default and auto-extends target.
- **Runtime namespaces are never cached.** Derived values referencing `process.*`, `request.*`, or any runtime namespace are evaluated fresh on every read.
- **Remote roots are read-only.** Config fetched from git or hosted CNOS cannot be written to via CLI.
- **Shiva for secret storage, CNOS for config orchestration.** These are separate systems with a clean provider interface between them.
