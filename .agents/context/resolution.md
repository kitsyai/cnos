# Resolution Reference

Resolution is the path from raw config entries to the final winning graph.

## What Shapes The Result

- active workspace
- workspace inheritance chain
- active profile
- profile inheritance chain
- loader/plugin precedence
- promotion rules
- derived value dependencies
- validation and safety checks

## Practical Order

At a high level:

1. discover the root and workspace anchor
2. load and normalize the manifest
3. resolve workspace context
4. resolve profile context
5. load entries from plugins
6. merge entries by precedence
7. promote public keys
8. evaluate config-only derivations and track runtime-dependent ones
9. validate the resulting graph
10. export/project the graph for the requested surface

## Debugging Tools

Use the CLI instead of guessing:

- `cnos inspect <key>`: winner, overrides, provenance, derivation details
- `cnos diff <left> <right>`: compare profiles for one workspace
- `cnos drift`: compare resolved graph against schema expectations
- `cnos list [namespace]`: inspect namespace-level output

The canonical command forms live in `packages/cli/src/cli/helpRegistry.ts` and `cnos help-ai --format json`.
