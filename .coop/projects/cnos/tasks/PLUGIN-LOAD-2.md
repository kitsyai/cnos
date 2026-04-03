---
id: PLUGIN-LOAD-2
short_id: 75e324793a1f
title: Implement env and CLI loaders with bidirectional env mapping
type: feature
status: done
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - PLUGIN-LOAD-1
delivery: v1
acceptance:
  - plugins/dotenv, plugins/process-env, and plugins/cli-args each expose
    dedicated loader modules that return ConfigEntry arrays with origin metadata
    and no cross-plugin boundary collapse.
  - packages/core implements bidirectional SCREAMING_SNAKE env mapping with
    explicit manifest overrides and secret-prefix preservation.
  - The default precedence pipeline is filesystem less-than dotenv less-than
    process-env less-than cli-args, and inspect/provenance has enough data to
    explain winners later.
  - Tests cover explicit and convention-based mapping, secret/value env naming,
    invalid input diagnostics, and precedence across all loader types.
tests_required:
  - Unit tests for envNaming and explicit override resolution.
  - Integration tests that run the combined loader pipeline with fixture
    manifest mappings and competing sources.
origin:
  authority_refs:
    - docs/cnos-v1-canonical-spec.md
    - docs/cnos-v1-codex-bootstrap-prompt.md
---
Build plugins/dotenv, plugins/process-env, and plugins/cli-args plus the shared env naming/mapping utilities in packages/core.