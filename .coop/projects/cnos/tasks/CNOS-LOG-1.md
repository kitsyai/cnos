---
id: CNOS-LOG-1
short_id: 3f2f8572b0e1
title: Production logging integrations for CNOS format/log
type: feature
status: todo
created: 2026-04-11
updated: 2026-04-11
aliases: []
priority: p2
track: v1
delivery: v1-5
acceptance:
  - CNOS exposes an adapter surface so format/log output can be routed through
    structured loggers without changing CNOS placeholder resolution semantics.
  - First-party integrations cover at least pino and winston, with a transport
    adapter shape that can support bunyan and morgan-style flows later.
  - Runtime docs and help show how to use cnos.format and cnos.log with a
    production logger in server applications.
tests_required:
  - Unit tests cover placeholder interpolation before adapter transport.
  - Integration tests cover pino and winston adapters with structured metadata.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-changeset-1.5.md
  derived_refs:
    - packages/docs/docs/api/runtime.mdx
    - docs/cnos-how-to.md
---

## Context
CNOS now has minimal `cnos.format(...)` and `cnos.log(...)` helpers for direct
runtime interpolation. That is enough for local development and simple server
logs, but production applications often standardize on structured logging
libraries such as pino or winston and need CNOS interpolation to flow through
those transports instead of `console.log`.

## Technical Notes
- Keep CNOS placeholder resolution (`${logical.key}`) as the shared primitive.
- Add an adapter or transport abstraction rather than hard-coding a single
  logger implementation.
- Preserve the zero-dependency default runtime behavior for apps that do not
  install a production logger integration.
- Support structured metadata so callers can attach context in addition to the
  formatted message.

## Open Questions
- Should logger adapters live in `@kitsy/cnos` or in separate packages such as
  `@kitsy/cnos-pino` and `@kitsy/cnos-winston`?
- Do we want `cnos.log` to remain plain-text only, with structured logging as a
  separate API such as `cnos.logger(...)`?
