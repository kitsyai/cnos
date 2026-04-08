---
id: CLI-WATCH-1
short_id: 07daaf6a8e43
title: Config watch and reload loop
type: feature
status: in_review
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p2
track: unassigned
delivery: v1-3
acceptance:
  - cnos watch resolves the contributing config file set, watches for changes,
    and re-resolves the graph with debounced updates.
  - Restart mode respawns the child process with updated env/runtime bootstrap
    data after config changes.
  - Signal mode emits changed logical keys as JSON without spawning a child.
tests_required:
  - Unit tests cover watched file discovery and resolved-graph diffing.
  - CLI/integration tests cover restart mode, signal mode, debounce behavior,
    and new file creation under watched directories.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-changeset-1.3.md
  derived_refs:
    - docs/cnos-v1-complete-test-suite.md
---
