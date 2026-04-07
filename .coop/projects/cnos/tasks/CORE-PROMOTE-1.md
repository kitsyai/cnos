---
id: CORE-PROMOTE-1
short_id: 739a7dc6c282
title: Manifest-driven namespaces and promote CLI
type: feature
status: done
created: 2026-04-07
updated: 2026-04-07
aliases: []
priority: p2
track: v1
delivery: v1-2
acceptance:
  - Manifest normalizes namespace defaults including public and env projection
    namespaces.
  - Promoted value.* keys become readable as public.* while sensitive namespaces
    hard-fail on promotion.
  - CLI supports cnos promote ... --to public|env and updates the manifest
    deterministically.
tests_required:
  - Core tests cover namespace defaults, promotion graph mirroring, and
    promotion security failures.
  - CLI tests cover promote command mutations for public.promote and
    envMapping.explicit.
origin:
  authority_refs:
    - docs/cnos-changeset-1.2.md
    - docs/daily-use-cases.md
  derived_refs: []
---
