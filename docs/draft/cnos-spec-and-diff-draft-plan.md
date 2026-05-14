# CNOS Spec and Diff - Draft Feature Plan

## Purpose

This document is a review draft for two linked features:

1. `cnos spec` - a first-class config specification surface where developers define what a config key is, what it is used for, what values are allowed, and whether the key is required or optional.
2. `cnos diff` expansion - a broader comparison surface for values and specs across profiles, workspaces, inherited base layers, and declared spec requirements.

This is not the final implementation plan. The goal here is to align on the feature shape, naming, storage model, command UX, and rollout order before writing implementation-ready tasks.

---

## Problem

Today CNOS already has a manifest `schema` section, but it is narrow. It covers type validation and defaults, not the richer developer-facing definition of a config key.

Current gaps:

- the person using a library often has to search docs or source code to understand a config key
- the current CNOS schema cannot describe what a key is for, where it is expected to be used, or what a valid choice means
- `cnos drift` only answers part of the problem: required/missing/type mismatch
- `cnos diff` only compares two profiles in one workspace, and only at the resolved value layer
- the UI can browse config state, but it cannot yet help a user define spec, fill missing config, or compare contexts

The proposed direction is to make CNOS the place where config definition and config values meet:

- one authoritative spec for keys
- one authoritative value graph
- first-class tooling to compare the two
- first-class tooling to help users fill gaps safely

---

## Current Repo Reality

The existing system already gives us useful building blocks:

- manifest-level `schema` exists today in [`packages/core/src/types/manifest.ts`](../../packages/core/src/types/manifest.ts)
- current schema rules are limited to `type`, `required`, `enum`, `pattern`, and `default` in [`packages/core/src/types/schema.ts`](../../packages/core/src/types/schema.ts)
- schema rules are already applied during runtime creation in [`packages/core/src/validation/basicSchema.ts`](../../packages/core/src/validation/basicSchema.ts)
- `cnos drift` already compares manifest schema to the resolved graph in [`packages/cnos/src/drift/compareSchemaToGraph.ts`](../../packages/cnos/src/drift/compareSchemaToGraph.ts)
- `cnos diff` already compares two profiles for one workspace in [`packages/cli/src/commands/diff.ts`](../../packages/cli/src/commands/diff.ts)
- `cnos doctor` already has a diagnostics pattern and JSON/plain output in [`packages/cli/src/commands/doctor.ts`](../../packages/cli/src/commands/doctor.ts)
- `cnos ui` already has an API bridge and a React shell for summary/list/inspect flows in [`packages/cli/src/commands/ui.ts`](../../packages/cli/src/commands/ui.ts) and [`packages/ui/src/App.tsx`](../../packages/ui/src/App.tsx)

This means the right move is to extend the existing model, not introduce a parallel config-definition system.

---

## Recommendation Summary

### 1. Keep one manifest authority

Do not introduce a second top-level config-definition file or a second independent spec registry.

Recommended direction:

- keep the manifest as the authority
- evolve the current `schema` concept into a richer "CNOS spec" model
- expose it to users through a new `cnos spec` command family

This keeps backward compatibility with the existing runtime validation, codegen, drift, and manifest loading paths.

Naming decision for this draft:

- `schema` remains the manifest field name in the first implementation wave
- `spec` is the user-facing product name for the config-definition experience
- CLI and docs must state this explicitly: CNOS spec is stored under `schema:` in the manifest

Rationale:

- lowest migration cost
- no dual-authority `schema` and `spec` blocks
- no compatibility cliff for existing manifests, codegen, or drift
- implementation planning can proceed without waiting on a broader manifest rename

### 2. Separate spec authoring from value authoring

`cnos define` should remain the command that writes actual config values or secret refs.

`cnos spec` should become the command family that authors and inspects config definitions.

This preserves the mental model:

- `cnos spec ...` defines what a key means
- `cnos define` / `cnos value set` / `cnos secret set` define what a key currently is

### 3. Unify comparison logic under one comparison engine

`drift` and the new `diff` modes should share one comparison engine with different views:

- spec vs resolved graph
- profile vs profile
- workspace vs workspace
- current workspace/profile vs inherited base chain

The current `cnos drift` command should remain as a compatibility surface in the first rollout, but it should become a thin wrapper over the shared comparison service.

### 4. Build CLI/core first, then UI

The UI should not invent its own rules. It should reuse the same backend services and comparison payloads as the CLI.

Recommended order:

1. spec data model
2. spec authoring and listing CLI
3. spec doctor / gap-filling CLI
4. shared diff engine
5. UI flows on top

---

## Proposed Product Shape

## Feature A - `cnos spec`

### What `cnos spec` means

`cnos spec` is the developer-authored definition of a config key.

It answers:

- what is this key?
- which namespace and logical key does it belong to?
- what type does it hold?
- is it required?
- what values are allowed?
- what is the default?
- what is it used for?
- where is it expected to be consumed?
- is it deprecated?
- what should a user know before setting it?

### Recommended scope for the first version

The first version should stay focused on fields that materially improve understanding, validation, and guided input.

Recommended v1 spec fields:

```ts
interface ConfigSpecRule {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  pattern?: string;
  summary?: string;
  description?: string;
  examples?: unknown[];
  usedBy?: string[];
  deprecated?: boolean;
  deprecationMessage?: string;
}
```

Notes:

- `summary` is the short human-facing explanation
- `description` is the longer help text
- `examples` are example values, not active defaults
- `usedBy` is intentionally lightweight text in v1, for example `["server runtime", "vite public build"]`
- we should not add ownership, tickets, or team metadata in v1 unless there is a concrete product use for it

### Storage recommendation

Recommended v1 storage:

```yaml
schema:
  value.server.port:
    type: number
    required: true
    summary: HTTP server port
    description: Port bound by the backend HTTP listener.
    examples: [3000, 8080]
    usedBy:
      - server runtime
  value.app.stage:
    type: string
    required: true
    enum: [local, stage, prod]
    summary: Deployment stage
    description: Selects stage-aware endpoints and safety behavior.
```

Rationale:

- no new top-level manifest section yet
- no migration cliff for existing `schema`
- current codegen and drift can be extended instead of replaced
- the CLI can still present this user-facing concept as "spec"

Required docs/help wording:

- `cnos spec` help text and docs must say that spec definitions are stored under `schema:` in `.cnos/cnos.yml`
- generated examples should show both the command and the resulting YAML location

### CLI surface recommendation

Recommended command family:

```bash
cnos spec list
cnos spec show <logicalKey>
cnos spec set <logicalKey> [flags...]
cnos spec delete <logicalKey>
cnos spec doctor
```

Recommended behavior:

- `spec list` shows declared manifest-global spec entries; in v1 spec visibility is not workspace-scoped
- `spec show` shows one key's definition with human-readable fields
- `spec set` writes or updates the manifest spec entry
- `spec delete` removes a spec entry
- `spec doctor` compares spec expectations to real config and can guide the user through filling gaps

### `cnos spec set` draft UX

Two authoring modes should exist:

1. explicit flags for non-interactive use
2. interactive prompt mode when invoked without any field flags and stdout is a TTY

Example:

```bash
cnos spec set value.server.port \
  --type number \
  --required \
  --summary "HTTP server port" \
  --description "Port bound by the backend HTTP listener." \
  --example 3000 \
  --example 8080 \
  --used-by "server runtime"
```

Interactive mode example:

```bash
cnos spec set value.server.port
```

Prompt flow:

1. key
2. type
3. required or optional
4. default value
5. enum or open value
6. summary
7. description
8. examples
9. used by

Trigger rule:

- if `cnos spec set` is called with no field flags and stdout is a TTY, enter interactive mode
- if any field flag is provided, use non-interactive flag-driven mode
- if no field flags are provided and stdout is not a TTY, fail with a clear usage error instead of guessing

### `cnos spec doctor` draft UX

This is the second half of the feature and the more valuable user flow.

It should answer:

- which required spec keys are missing?
- which values exist without a spec?
- which values violate enum/pattern/type?
- which keys still use defaults?
- which spec entries are deprecated but still defined?

Recommended modes:

```bash
cnos spec doctor
cnos spec doctor --json
cnos spec doctor --fill-missing
cnos spec doctor --review-all
cnos spec doctor --workspace api --profile stage
```

Behavior:

- plain `doctor` reports the gap set
- `--fill-missing` prompts only for missing required values
- `--review-all` walks every declared spec entry one by one, showing current value and allowing keep/update/skip
- spec is manifest-global in v1, but doctor evaluates that global spec against the selected workspace/profile context

Prompting rules:

- value keys should route through existing value-writing behavior
- secret keys must route through the existing secure secret-writing path
- secret prompts must never echo plaintext
- remote roots must remain read-only; doctor can report but not write
- each accepted value is committed immediately after validation; doctor sessions are per-key atomic, not all-or-nothing

Prompt flow for a missing key:

1. show key
2. show summary / description
3. show allowed values or pattern if present
4. show current state: missing / defaulted / mismatched
5. prompt for new value
6. validate immediately
7. write through CNOS write policy

For enum-backed values, the prompt should prefer numbered choices over free-form input.

### Non-interactive behavior

Non-interactive environments must not block on prompts.

Recommended rules:

- `cnos spec doctor` works normally in read-only mode
- `cnos spec doctor --fill-missing` in non-TTY mode should fail with a clear message unless explicit `--set` or input-file support is added in a later phase
- secret values should never be accepted as plain CLI args in strict mode, consistent with current repo rules

Discoverability rule:

- when spec issues are present, existing `cnos doctor` should include a pointer such as `Run cnos spec doctor to review config spec coverage.`

---

## Feature B - `cnos diff` expansion

### Problem with the current diff

Current `cnos diff` is useful but too narrow:

- it only compares two profiles
- it assumes one workspace context
- it does not show inheritance/base relationships directly
- it does not compare the resolved graph against the declared spec
- drift lives beside diff instead of being part of one comparison story

### Recommended mental model

`cnos diff` should become the general comparison surface.

Recommended comparison targets:

1. resolved graph vs resolved graph
2. resolved graph vs spec
3. effective target vs inherited base chain

### Recommended command family

Keep the existing command working:

```bash
cnos diff local stage --workspace api
```

Expand with subcommands:

```bash
cnos diff profiles <left> <right> [--workspace <id>]
cnos diff workspaces <left> <right> [--profile <name>]
cnos diff base [--workspace <id>] [--profile <name>]
cnos diff spec [--workspace <id>] [--profile <name>]
```

Compatibility rule:

- `cnos diff <left> <right>` remains as an alias for `cnos diff profiles <left> <right>`

### Meaning of each mode

#### `cnos diff profiles`

Compare the effective resolved graph for two profiles in the same workspace.

Report:

- changed keys
- keys added in right
- keys missing in right
- changed source provenance when the value is equal but the winner changes

#### `cnos diff workspaces`

Compare two workspaces under the same profile.

Report:

- changed values
- keys present only in one workspace
- whether the value came from local workspace or inherited parent

#### `cnos diff base`

Compare the selected workspace/profile against its inherited workspace chain.

This should answer:

- what does this workspace override from base?
- what values are inherited unchanged?
- what keys are newly introduced here?

This is valuable for monorepo users trying to understand what an app-specific workspace changed.

Complexity note:

- this is materially harder than `diff profiles` and `diff workspaces`
- it is not just "compare two runtimes"; it needs workspace-layer-aware provenance and override grouping
- implementation planning should treat this as the hardest diff mode
- if scope pressure appears, `diff base` can move behind `diff spec` and `diff workspaces` as a Phase 4.5 item

#### `cnos diff spec`

Compare the declared spec against the effective resolved graph.

This is conceptually what current `cnos drift` already does, but the expanded version should include richer spec fields.

Report:

- missing required keys
- undeclared keys
- type mismatches
- enum violations
- pattern violations
- deprecated keys still in use
- defaults applied
- spec-only informational context such as summary and allowed values

Important note:

- enum and pattern comparison are new comparison work, not just formatting of existing drift output
- current runtime validation already enforces enum and pattern, but current drift comparison does not report them

### Relationship between `diff spec` and `drift`

Recommended rollout:

- keep `cnos drift` as-is for compatibility
- implement a shared comparison service
- have `cnos drift` call the shared service in "spec drift" mode
- introduce `cnos diff spec` as the more discoverable surface

This avoids breaking current users while aligning the product around one comparison model.

---

## Shared Data Model Proposal

## 1. Evolve `SchemaRule` into a richer rule type

Current:

```ts
interface SchemaRule {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  enum?: unknown[];
  pattern?: string;
  default?: unknown;
}
```

Proposed draft direction:

```ts
interface ConfigSpecRule {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  enum?: unknown[];
  pattern?: string;
  default?: unknown;
  summary?: string;
  description?: string;
  examples?: unknown[];
  usedBy?: string[];
  deprecated?: boolean;
  deprecationMessage?: string;
}
```

Draft compatibility approach:

- keep the manifest field name `schema` in the first rollout
- rename the TypeScript type from `SchemaRule` to `ConfigSpecRule` only if the refactor cost is acceptable
- otherwise keep `SchemaRule` as the internal type name for compatibility and document it as the CNOS spec model

### Recommendation

For the first implementation, preserve the manifest field name and preserve the internal type name unless a refactor is already justified for adjacent work. The user-facing language remains "spec", but docs and help must explicitly say that CNOS spec is stored under `schema:` in the manifest. The main objective is behavior, not a broad repo-wide rename.

## 2. Add structured comparison payloads

The shared diff engine should emit typed comparison payloads instead of building command-specific strings first.

Draft shape:

```ts
type DiffMode = 'profiles' | 'workspaces' | 'base' | 'spec';

type GraphDiffStatus = 'changed' | 'added' | 'removed';
type SpecDiffStatus = 'missing' | 'undeclared' | 'mismatch' | 'defaulted' | 'deprecated';

interface GraphDiffRow {
  key: string;
  status: GraphDiffStatus;
  leftValue?: unknown;
  rightValue?: unknown;
  leftMasked?: boolean;
  rightMasked?: boolean;
  sourceFile?: string;
}

interface SpecDiffRow {
  key: string;
  status: SpecDiffStatus;
  value?: unknown;
  masked?: boolean;
  expectedType?: string;
  actualType?: string;
  summary?: string;
  sourceFile?: string;
}

type DiffRow = GraphDiffRow | SpecDiffRow;

interface DiffReport {
  mode: DiffMode;
  workspace?: string;
  profile?: string;
  rows: DiffRow[];
}
```

This same payload can feed:

- CLI text rendering
- CLI JSON output
- UI comparison views

Placement recommendation:

- define `DiffMode`, `DiffRow`, and `DiffReport` in `packages/core/src/types/diff.ts`
- re-export them from higher layers as needed
- keep command renderers and formatters in CLI/runtime packages, but keep the serializable comparison contracts in core

---

## Command Design Draft

## `cnos spec`

Recommended public commands for the review draft:

```bash
cnos spec list [--prefix <path>] [--json]
cnos spec show <logicalKey> [--json]
cnos spec set <logicalKey> [fields...]
cnos spec delete <logicalKey> [--json]
cnos spec doctor [--fill-missing|--review-all] [--json]
```

Recommended optional fields for `spec set`:

```bash
--type <string|number|boolean|object|array>
--required
--optional
--default <jsonOrScalar>
--enum <jsonArray>
--pattern <regex>
--summary <text>
--description <text>
--example <value>   # repeatable
--used-by <text>    # repeatable
--deprecated
--deprecation-message <text>
```

Deliberately out of scope for the first draft:

- spec import from source code
- spec generation from runtime inspection
- markdown-rich descriptions
- field-level ACLs
- custom per-type UI widgets

## `cnos diff`

Recommended public commands for the review draft:

```bash
cnos diff <leftProfile> <rightProfile>
cnos diff profiles <left> <right>
cnos diff workspaces <left> <right> [--profile <name>]
cnos diff base [--workspace <id>] [--profile <name>]
cnos diff spec [--workspace <id>] [--profile <name>]
```

Potential later additions, not phase 1:

```bash
cnos diff roots local global
cnos diff current --against base
cnos diff spec --only missing
```

---

## UI Direction

The UI already has list/inspect primitives. The new features should extend that shell instead of replacing it.

Recommended UI phases:

### Phase UI-1: read-only spec and diff

Add backend endpoints:

- `GET /api/spec/list`
- `GET /api/spec/show?key=...`
- `GET /api/diff?...`

Add UI views:

- Spec tab
- Diff tab
- filters for workspace and profile

### Phase UI-2: guided spec doctor

Add backend endpoints:

- `POST /api/spec/doctor/run`
- `POST /api/spec/doctor/apply`

Add UI flows:

- missing config queue
- one-by-one guided input
- enum choice selection
- secret entry flow with masked input

### Phase UI-3: spec authoring

Add UI forms for:

- create spec entry
- edit summary/description/type/enum/default
- delete spec entry

Important constraint:

- UI write flows must call the same backend services as CLI write flows
- the UI must not bypass write policy, workspace selection, secret handling, or remote-root read-only checks

---

## Architecture and Module Placement

This section is still draft-level, but the write surfaces are clear enough for review.

## Core

Likely write surfaces:

- `packages/core/src/types/schema.ts`
- `packages/core/src/types/manifest.ts`
- `packages/core/src/types/diff.ts`
- `packages/core/src/validation/basicSchema.ts`

Possible additions:

- `packages/core/src/spec/` for shared spec comparison helpers if the logic grows beyond validation

## Runtime / internal helpers

Likely write surfaces:

- `packages/cnos/src/drift/compareSchemaToGraph.ts`
- `packages/cnos/src/drift/formatDriftReport.ts`

Possible refactor:

- introduce a more generic comparison directory such as `packages/cnos/src/diff/`
- keep `drift/` as a compatibility layer or formatter layer if needed

## CLI

Likely additions:

- `packages/cli/src/commands/spec.ts`
- `packages/cli/src/services/spec/`
- update `packages/cli/src/cli/helpRegistry.ts`
- update `packages/cli/src/index.ts`

Likely diff changes:

- extend `packages/cli/src/commands/diff.ts`
- add shared comparison rendering helpers

## UI

Likely write surfaces:

- `packages/cli/src/commands/ui.ts`
- `packages/ui/src/App.tsx`

If the UI grows materially, split the React app into route-like panels or feature components instead of keeping everything in one file.

---

## Security and Invariants

These features must preserve existing CNOS rules.

### Non-negotiable rules

- spec definitions never contain secret values
- secret prompts never print plaintext
- `secret.*` and `sensitive: true` namespaces never reach public/browser surfaces
- remote roots remain read-only
- workspaces and profiles stay orthogonal
- runtime-dependent values are not cached incorrectly

### Specific implications

#### For `cnos spec`

- spec metadata may describe secret keys, but value filling must still go through the vault/ref flow
- `usedBy` and descriptions are documentation metadata only; they do not grant permission to expose values to a surface

#### For `cnos diff`

- JSON and text diff output must still respect masking rules for secrets by default
- if a future `--reveal` mode is added to diff, it should follow the same safety rules as current secret listing and env export
- the existing unmasked `secret.*` behavior in `packages/cli/src/commands/diff.ts` must be fixed as part of the shared diff-engine rollout, not carried forward

---

## Rollout Recommendation

## Phase 1 - Spec model expansion

Build:

- richer spec fields in manifest type
- validation compatibility
- read-only spec list/show CLI

Do not build yet:

- interactive doctor
- UI editing
- diff expansion beyond spec mode

Why:

- this settles the data model first

## Phase 2 - Spec authoring CLI

Build:

- `cnos spec set`
- `cnos spec delete`
- text and JSON output

Why:

- once the shape is stable, authors need a way to write it

## Phase 3 - Spec doctor

Build:

- report mode
- `--fill-missing`
- `--review-all`
- secure secret handling

Why:

- this is the operational feature users will feel most

## Phase 4 - Shared diff engine

Build:

- shared comparison service
- `cnos diff spec`
- `cnos diff workspaces`
- make `cnos drift` call the shared service
- secret masking by default for all diff text and JSON output
- enum and pattern comparison for spec diff

Optional if design and time allow:

- `cnos diff base`

Why:

- after spec exists, comparison should widen cleanly
- `diff profiles`, `diff workspaces`, and `diff spec` share a simpler two-context comparison model
- `diff base` is a provenance-aware inheritance comparison and may need a follow-up design slice

## Phase 4.5 - Base inheritance diff

Build:

- `cnos diff base`
- workspace-layer-aware provenance reporting

Why:

- this mode is the most architecture-specific and should not block the simpler diff modes

## Phase 5 - UI integration

Build:

- read-only spec and diff views first
- guided doctor flow second
- spec editing third

Why:

- UI should sit on proven APIs

---

## Test Plan Draft

This is the review-phase test outline, not the final implementation matrix.

### Spec model

- old manifests with simple schema continue to load
- rich spec fields normalize correctly
- codegen remains stable when only old schema fields are used
- validation ignores informational fields and still enforces semantic ones

### Spec authoring CLI

- create a new spec entry
- update an existing spec entry
- delete a spec entry
- interactive prompt writes valid YAML
- invalid enum/pattern/default shapes are rejected

### Spec doctor

- missing required value is reported
- enum mismatch is reported
- deprecated key usage is reported
- `--fill-missing` writes value keys through value write policy
- `--fill-missing` writes secret keys through secure secret write flow
- non-TTY write mode fails clearly instead of hanging
- remote root doctor reports gaps but refuses writes

### Diff expansion

- profile vs profile diff still works
- workspace vs workspace diff reports added/removed/changed keys
- base diff shows overrides vs inherited values
- spec diff matches current drift semantics plus richer metadata
- spec diff reports enum and pattern violations as new comparison behavior
- secret values are masked by default in output

### UI integration

- spec list and show endpoints match CLI data
- diff endpoint payloads match CLI JSON shape
- guided UI doctor can write value keys
- guided UI doctor can write secret keys without plaintext leaks

---

## Open Questions For Review

These should be resolved before converting this into an implementation plan.

1. Should `usedBy` stay lightweight text, or do we want structured surface identifiers in v1?
2. Do we want `cnos spec doctor` as a new command, or should we extend the existing `cnos doctor` command with a spec mode beyond the proposed pointer?
3. Should `cnos diff spec` become the primary surface and `cnos drift` become a compatibility alias, or should drift remain first-class indefinitely?
4. Do we want secret-aware diff reveal in the first rollout, or keep diff masked-only?
5. Should `spec set` support a fully non-interactive JSON payload mode in phase 1, or can that wait?
6. How much of the UI should ship in the same implementation wave as CLI/core, versus a later review after the backend stabilizes?

---

## Recommended Review Outcome

If this direction is accepted, the next document should be an implementation plan with:

- final command names
- final type definitions
- exact file/module write list
- compatibility strategy for existing `schema`, `drift`, and `diff`
- test IDs and execution order
- UI API contract

My recommendation is to approve the direction with these key decisions:

- keep manifest authority unified
- present the feature publicly as `cnos spec`
- preserve `schema` as the stored field in the first rollout
- state explicitly that CNOS spec is stored under `schema:` in the manifest
- treat `spec doctor` as a new command family, not as a silent expansion of current `doctor`
- expand `diff` with subcommands and move `drift` onto the same engine later
- ship secret masking and simpler diff modes before taking on `diff base`
