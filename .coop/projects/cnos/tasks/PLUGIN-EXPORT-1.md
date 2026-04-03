---
id: PLUGIN-EXPORT-1
short_id: b0c2377904d2
title: Implement env export and public projection plugin
type: feature
status: todo
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - CORE-PROFILE-1
delivery: v1
acceptance:
  - plugins/env-export exposes toEnv() and toPublicEnv() modules driven by the
    resolved graph and manifest export/public configuration.
  - Public promotion includes only declared value.* keys and rejects any
    secret.* promotion attempt with a clear validation error.
  - Framework projection supports Next, Vite, and Nuxt prefixes plus explicit
    custom prefix override.
  - Tests cover logical-to-env conversion, namespace filtering, public promotion
    safety, framework prefix output, and export behavior under different
    profiles.
tests_required:
  - Unit tests for env projection helpers and public filtering rules.
  - Integration tests for runtime toEnv()/toPublicEnv() output from resolved
    fixture graphs.
origin:
  authority_refs:
    - docs/cnos-v1-canonical-spec.md
    - docs/cnos-v1-codex-bootstrap-prompt.md
---
Build the export surface in plugins/env-export and hook it into the runtime projection APIs from packages/core and packages/cnos.