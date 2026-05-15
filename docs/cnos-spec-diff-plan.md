# CNOS Spec and Diff - Implementation Plan (Phases 1-3)

Source draft: `docs/draft/cnos-spec-and-diff-draft-plan.md`  
Plan date: 2026-05-15

## 1. Findings / Contradictions

1. **Phase boundary mismatch in the draft**: the approved draft places `spec list/show` in Phase 1, while this request scopes Phase 1 as model expansion.  
   Resolution in this plan: keep Phase 1 strictly model+contract foundations; move `spec list/show` into Phase 2 with the `cnos spec` command family.

2. **Draft proposes shared diff contracts early (`types/diff.ts`)** while this request defers diff expansion.  
   Resolution in this plan: do **not** introduce general diff contracts in Phases 1-3 unless needed for `spec doctor`. Any broad `diff` contract work is deferred to follow-up planning.

3. **No product-direction contradiction found** with the locked decisions below; this plan preserves all approved decisions.

## 2. Final Implementation Scope

### In Scope Now (Phases 1-3)

- Expand manifest `schema:` rule model to support the approved spec metadata fields.
- Keep one manifest authority and keep `schema:` as the stored field name.
- Introduce `cnos spec` command family for authoring and inspection:
  - `cnos spec list`
  - `cnos spec show <logicalKey>`
  - `cnos spec set <logicalKey> ...`
  - `cnos spec delete <logicalKey>`
- Implement `cnos spec doctor` with:
  - report mode
  - `--fill-missing`
  - `--review-all`
  - secret-safe prompting/writes
  - non-TTY handling
  - remote-root read-only behavior
- Keep `cnos define` as value authoring.
- Keep `cnos doctor` and add a pointer to `cnos spec doctor` (no replacement).
- Keep spec manifest-global in v1 (not workspace-scoped).

### Deferred (Follow-up Planning / Later Phases)

- Expanded `cnos diff` command family (`profiles/workspaces/base/spec` subcommands).
- Shared multi-mode diff engine beyond what `spec doctor` minimally needs.
- UI authoring/doctor flows (`packages/ui`).
- Published docs package feature expansion beyond CLI command-page parity required during implementation.

## 3. File-by-File Implementation Map

### Foundational Files (used across phases)

#### `packages/core`

- **Modify** `packages/core/src/types/schema.ts`  
  Backward-compatible expansion of `SchemaRule` fields for spec metadata.
- **Add** `packages/core/src/types/spec.ts`  
  Canonical spec model and spec-doctor report contracts (core ownership).
- **Modify** `packages/core/src/types/manifest.ts`  
  Point manifest `schema` typing to shared spec rule type(s).
- **Modify** `packages/core/src/types/plugin.ts`  
  Validation context typing alignment (schema/spec aliasing).
- **Add** `packages/core/src/spec/normalizeSpecRule.ts`  
  Rule normalization helpers (trim/sanitize arrays/strings; preserve semantic fields).
- **Modify** `packages/core/src/manifest/normalizeManifest.ts`  
  Normalize all `schema` entries through shared spec normalization.
- **Modify** `packages/core/src/validation/basicSchema.ts`  
  Keep runtime semantic enforcement (`type|required|default|enum|pattern`) and ignore informational spec fields.
- **Modify** `packages/core/src/index.ts`  
  Export new core spec types/helpers.

#### `packages/cnos`

- **Add** `packages/cnos/src/spec/compareSpecToGraph.ts`  
  Shared comparison service for Phase 3 doctor and drift compatibility.
- **Modify** `packages/cnos/src/drift/compareSchemaToGraph.ts`  
  Keep drift compatibility wrapper; route through shared spec comparison output.
- **Modify** `packages/cnos/src/drift/formatDriftReport.ts`  
  Preserve current drift text while adapting to shared comparison internals.
- **Modify** `packages/cnos/src/internal.ts`  
  Export new comparison service/types for CLI consumption.

#### `packages/cli`

- **Modify** `packages/cli/src/cli/parseArgs.ts`  
  Register new `--type`, `--default`, `--enum`, `--pattern`, `--summary`, `--description`, `--example`, `--used-by`, `--deprecation-message` option-value flags; add doctor mode flags parsing.
- **Modify** `packages/cli/src/cli/commandOptions.ts`  
  Add repeatable option helper (for `--example` and `--used-by`).
- **Modify** `packages/cli/src/cli/helpRegistry.ts`  
  Add `spec` and `spec *` help entries; update `doctor` description with pointer behavior.
- **Modify** `packages/cli/src/index.ts`  
  Route `spec` command family.
- **Modify** `packages/cli/src/commands/doctor.ts`  
  Add pointer line to `cnos spec doctor`. Trigger rule: show the pointer whenever manifest `schema:` is non-empty (see §6 Phase 3 step 5 for the canonical rule).

### Phase-Specific Files

#### Phase 2 (`cnos spec` authoring)

- **Add** `packages/cli/src/commands/spec.ts`
- **Add** `packages/cli/src/services/spec/manifestSpecStore.ts`  
  List/show/set/delete manifest `schema` entries; write via raw manifest rewrite.
- **Add** `packages/cli/src/services/spec/specSetInput.ts`  
  Parse/validate set flags, scalar coercion rules, repeatable fields.
- **Add** `packages/cli/src/services/spec/specPrompts.ts`  
  Interactive TTY prompts for `spec set`.

#### Phase 3 (`cnos spec doctor`)

- **Add** `packages/cli/src/services/spec/specDoctor.ts`  
  Build report; execute `--fill-missing` and `--review-all`; enforce per-key atomic writes.
- **Modify** `packages/cli/src/services/writes.ts` (if needed only)  
  Reuse existing secure write paths; do not bypass value/secret write policy.
- **Modify** `packages/cli/src/services/rootAccess.ts` (if needed only)  
  Reuse remote-root read-only guard for doctor write modes.

### Not Needed in Phases 1-3

- `packages/ui/*` (deferred)
- `packages/docs/*` (deferred except later command-doc sync)

## 4. Type and Contract Changes

### Spec Model Types (core)

`schema:` remains the manifest field name, with expanded rule fields:

- `type?: 'string' | 'number' | 'boolean' | 'object' | 'array'`
- `required?: boolean`
- `default?: unknown`
- `enum?: unknown[]`
- `pattern?: string`
- `summary?: string`
- `description?: string`
- `examples?: unknown[]`
- `usedBy?: string[]`
- `deprecated?: boolean`
- `deprecationMessage?: string`

Type ownership:

- `packages/core/src/types/spec.ts`: canonical `ConfigSpecRule`, `ConfigSpecMap`, `SpecDoctor*` report types.
- `packages/core/src/types/schema.ts`: compatibility export/alias preserving existing imports (`SchemaRule`).

### Manifest + Normalization Implications

- Existing schema-only manifests remain valid, with one explicit exception: manifests that carry `default`, `examples`, or `enum` on `secret.*` entries are rejected on load (see Validation Contract Changes below). This is an intentional, non-negotiable break required by the secret-safety rule in `CLAUDE.md`. It is **not** gated by a flag, version, or migration window.
- Normalization trims textual fields and drops empty strings/empty arrays for metadata fields.
- Semantic fields (`type|required|default|enum|pattern`) keep current behavior.
- Informational fields never affect runtime resolution output, projection, or env export.

### Validation Contract Changes

- `basicSchema` continues to enforce semantic rule behavior.
- Informational fields are ignored by runtime validation.
- Optional manifest-parse validation for malformed metadata types (e.g., non-string `summary`, non-array `examples`).
- For `secret.*` spec entries, manifest validation must reject plaintext-bearing spec fields:
  - `default`
  - `examples`
  - `enum`
- Enforcement is a hard load-time error (not a warning, not a deprecation window). The error message must:
  - name the offending logical key,
  - name the offending field(s),
  - point the user to the vault as the correct home for the value, and
  - state that removing the field from `schema:` will clear the error.
- This rule applies symmetrically to:
  - manifest load/normalization (existing manifests fail to load),
  - `cnos spec set` (rejects the flag at authoring time).

Rationale:

- the approved design says spec definitions never contain secret values
- repo rules forbid plaintext secrets in committed files
- allowing those fields on `secret.*` spec entries would create a committed-secret path through `schema:`
- a soft warn-then-error would leave a window in which plaintext secrets are accepted; the security model does not permit that window

### CLI JSON Contracts to Define Now

#### `cnos spec list --json`

```json
{
  "manifestPath": "/abs/path/.cnos/cnos.yml",
  "entries": [
    { "key": "value.server.port", "rule": { "type": "number", "required": true, "summary": "..." } }
  ]
}
```

#### `cnos spec show <key> --json`

```json
{
  "key": "value.server.port",
  "rule": { "type": "number", "required": true },
  "manifestPath": "/abs/path/.cnos/cnos.yml"
}
```

#### `cnos spec set <key> ... --json`

```json
{
  "action": "created",
  "key": "value.server.port",
  "rule": { "type": "number", "required": true },
  "manifestPath": "/abs/path/.cnos/cnos.yml"
}
```

#### `cnos spec delete <key> --json`

```json
{
  "deleted": true,
  "key": "value.server.port",
  "manifestPath": "/abs/path/.cnos/cnos.yml"
}
```

#### `cnos spec doctor --json`

```json
{
  "workspace": "api",
  "profile": "stage",
  "summary": {
    "missingRequired": 1,
    "undeclared": 2,
    "typeMismatch": 0,
    "enumMismatch": 1,
    "patternMismatch": 0,
    "defaultApplied": 1,
    "deprecatedInUse": 0
  },
  "issues": [
    {
      "key": "value.server.port",
      "status": "missing_required",
      "expectedType": "number",
      "summary": "HTTP server port"
    }
  ],
  "mode": "report"
}
```

For write modes, include an additional `actions` array with per-key result (`applied|skipped|failed`).

Interactive-mode JSON rule:

- `cnos spec doctor --json` is valid for report mode only
- `cnos spec doctor --fill-missing --json` and `cnos spec doctor --review-all --json` are rejected in Phases 1-3
- this avoids mixing interactive prompts with machine-readable stdout contracts

## 5. Command Design (Implementation-Level)

### Phase 2 command set

1. `cnos spec list [--prefix <path>] [--json]`
2. `cnos spec show <logicalKey> [--json]`
3. `cnos spec set <logicalKey> [flags...]`
4. `cnos spec delete <logicalKey> [--json]`

### Phase 3 command set

1. `cnos spec doctor [--workspace <id>] [--profile <name>] [--json]`
2. `cnos spec doctor --fill-missing [--workspace <id>] [--profile <name>] [--json]`
3. `cnos spec doctor --review-all [--workspace <id>] [--profile <name>] [--json]`

### `cnos spec set` options

Value-setting flags:

- `--type <string|number|boolean|object|array>`
- `--required`
- `--optional`
- `--default <jsonOrScalar>`
- `--enum <jsonArray>`
- `--pattern <regex>`
- `--summary <text>`
- `--description <text>`
- `--example <value>` (repeatable)
- `--used-by <text>` (repeatable)
- `--deprecated`
- `--deprecation-message <text>`

Field-clearing flags (see Error handling rules below for full semantics and conflict matrix):

- `--clear-default`
- `--clear-enum`
- `--clear-pattern`
- `--clear-summary`
- `--clear-description`
- `--clear-examples`
- `--clear-used-by`
- `--clear-deprecated`
- `--clear-deprecation-message`

Parser/help wiring must register all flags in both groups. Any flag from either group counts as a "field flag" for the interactive-trigger rule below — running `spec set <key> --clear-summary` on a TTY performs the clear non-interactively.

### Interactive vs Non-interactive

- `spec set` with no field flags and TTY (`stdin` + `stdout`) enters interactive mode.
- `spec set` with any field flag uses non-interactive mode.
- `spec set` with no field flags and non-TTY fails with clear usage error.
- `spec set --json` is valid for non-interactive mode only; `spec set <key> --json` with no field flags is rejected in Phases 1-3 instead of mixing prompts with JSON stdout.
- `spec doctor --fill-missing` and `--review-all` require TTY; non-TTY fails clearly.
- Plain `spec doctor` report mode is always non-interactive.

### Error handling rules

- `--required` and `--optional` are mutually exclusive.
- `--deprecation-message` auto-sets `deprecated: true`.
- `--enum` must parse to array.
- `--enum` must not be empty; reject `[]`.
- `--default` and `--example` parse as:
  1. JSON value first
  2. if JSON parsing fails, treat as raw string
- JSON objects and arrays are valid values for `--default` and `--example` when they parse successfully.
- CLI flag parsing for spec authoring is JSON-first and does not use YAML parsing rules.
- Unknown logical key on `spec show` and `spec delete`: clear not-found behavior (`show` fails; `delete` returns `deleted: false`).
- Field clearing is explicit and never inferred from empty strings. Support clear flags for removable metadata fields:
  - `--clear-default`
  - `--clear-enum`
  - `--clear-pattern`
  - `--clear-summary`
  - `--clear-description`
  - `--clear-examples`
  - `--clear-used-by`
  - `--clear-deprecated`
  - `--clear-deprecation-message`
- `--clear-deprecated` must also clear `deprecationMessage`.
- Conflict rules:
  - `--default ...` with `--clear-default` rejects
  - `--enum ...` with `--clear-enum` rejects
  - `--pattern ...` with `--clear-pattern` rejects
  - `--summary ...` with `--clear-summary` rejects
  - `--description ...` with `--clear-description` rejects
  - `--example ...` with `--clear-examples` rejects
  - `--used-by ...` with `--clear-used-by` rejects
  - `--clear-deprecated` with `--deprecation-message ...` rejects
  - `--deprecated` with `--clear-deprecation-message` is allowed
- There is no `--no-deprecated` flag in Phases 1-3; `--clear-deprecated` is the explicit negation path.

### Secret-handling rules

- Spec definitions must never contain plaintext secret-bearing metadata for `secret.*` keys.
- `spec set` must reject `--default`, `--example`, and `--enum` for `secret.*` logical keys.
- Manifest validation/normalization must reject those fields if they already exist on `secret.*` entries.
- `spec doctor` secret input uses masked prompt and routes writes through existing secret write path (`setSecret`/vault flow).
- No secret plaintext emitted in text/JSON unless future explicit reveal mode (not in scope).

### Remote-root read-only behavior

- `spec list`, `spec show`, `spec doctor` report mode: allowed.
- `spec set`, `spec delete`, `spec doctor --fill-missing`, `spec doctor --review-all`: refused with existing read-only error pattern.

### Output behavior

- Text output: concise sectioned results with deterministic ordering by logical key.
- JSON output: stable top-level keys and machine-consumable per-key result status.
- Interactive doctor modes do not support `--json` in Phases 1-3; reject clearly instead of attempting mixed-mode output.
- Exit codes:
  - `0` no blocking issues, including cases where only warning-like statuses are present.
  - `1` report found blocking failures or write mode had failed/unresolved required issues.
  - command-usage errors also return non-zero.

Blocking statuses for `spec doctor`:

- `missing_required`
- `undeclared`
- `type_mismatch`
- `enum_mismatch`
- `pattern_mismatch`
- failed write actions in `--fill-missing` or `--review-all`

`--review-all` rule:

- if the user chooses `skip` for a `missing_required` issue, that issue remains unresolved and the run still exits `1`

Warning-only statuses for `spec doctor`:

- `default_applied`
- `deprecated_in_use`

## 6. Phase-by-Phase Execution Steps

### Phase 1 - Spec model expansion

1. Add core spec types and compatibility aliases.  
   Depends on: none.  
   Tests: core type/normalization tests.

2. Add spec normalization helper and wire into manifest normalization.  
   Depends on: step 1.  
   Tests: manifest backward compatibility and new-field normalization tests.

3. Update `basicSchema` to explicitly tolerate informational fields while preserving semantic enforcement.  
   Depends on: step 2.  
   Tests: existing schema enforcement tests + regression assertions.

4. Add/adjust cnos comparison foundation (`compareSpecToGraph`) while preserving existing drift contract.  
   Depends on: step 1-3.  
   Tests: drift compatibility tests remain green.
   Clarification: this Phase 1 deliverable is the shared comparison contract and comparison primitive needed by Phase 3 doctor work, not the full doctor feature itself.

### Phase 2 - Spec authoring CLI

1. Add CLI routing/help/parser support for `spec` command family.  
   Depends on: Phase 1 complete.  
   Tests: parseArgs/help/help-ai coverage.

2. Implement manifest spec store service (`list/show/set/delete`) with raw manifest rewrite.  
   Depends on: step 1.  
   Tests: create/update/delete and manifest persistence tests.

3. Implement non-interactive `spec set` parsing/validation.  
   Depends on: step 2.  
   Tests: enum/default/examples parsing, empty-enum rejection, explicit clear-flag behavior, conflict-rule validation, and `secret.*` rejection for secret-bearing spec fields.

4. Implement interactive `spec set` flow + non-TTY refusal path.  
   Depends on: step 3.  
   Tests: TTY-trigger behavior and non-TTY error behavior.

5. Implement `spec list`, `spec show`, `spec delete` text/json output contracts.  
   Depends on: step 2.  
   Tests: structured JSON contract snapshots and text assertions.

### Phase 3 - Spec doctor

1. Implement doctor report generation from shared spec comparison output.  
   Depends on: Phase 1 step 4.  
   Tests: reporting for missing/undeclared/type/enum/pattern/default/deprecated.

2. Implement `--fill-missing` write flow (missing required only).  
   Depends on: step 1 + Phase 2 spec/write services.  
   Tests: value writes, secret writes, per-key atomic writes.

3. Implement `--review-all` guided flow.  
   Depends on: step 1.  
   Tests: keep/update/skip behavior and interruption safety.

4. Wire remote-root write refusal and non-TTY refusal for write modes.  
   Depends on: step 2/3.  
   Tests: remote root refusal, non-interactive refusal, and `--json` rejection for interactive doctor modes.

5. Update `cnos doctor` to point to `cnos spec doctor` when relevant.  
   Depends on: step 1.  
   Trigger rule: in Phases 1-3, show the pointer whenever manifest `schema:` is non-empty.  
   Tests: doctor pointer appears without replacing existing doctor behavior.

## 7. Test Plan

### Files to update/add

#### `packages/core`

- **Update** `packages/core/test/cnos-core.test.ts`
- **Add** `packages/core/test/spec-model.test.ts`

Mandatory cases:

- Backward compatibility: existing schema manifests load unchanged.
- New fields normalize correctly.
- Semantic enforcement unchanged (`required`, `type`, `enum`, `pattern`, `default`).
- Informational fields do not alter runtime resolution/projection.
- `secret.*` spec entries reject `default`, `examples`, and `enum`.

#### `packages/cnos`

- **Update** `packages/cnos/test/drift.test.ts`
- **Add** `packages/cnos/test/spec-compare.test.ts`

Mandatory cases:

- Drift output remains backward compatible.
- Spec comparison reports enum/pattern/default/deprecated statuses correctly.
- Transient runtime sources remain excluded from undeclared reporting.

#### `packages/cli`

- **Update** `packages/cli/test/cnos-cli.test.ts`
- **Add** `packages/cli/test/spec-cli.test.ts`
- **Add** `packages/cli/test/spec-doctor.test.ts`

Mandatory cases before approval:

- Backward compatibility for existing schema manifests.
- `spec set` create/update/delete behavior.
- explicit field-clearing behavior for removable metadata fields.
- conflict rules for value-setting flags vs `--clear-*` flags.
- Interactive trigger behavior (`TTY + no field flags` => prompt).
- Non-TTY behavior (`spec set` no flags, `spec doctor --fill-missing`, `--review-all` => fail clearly).
- `--json` rejection for interactive doctor modes.
- `spec doctor` report coverage (missing/undeclared/type/enum/pattern/default/deprecated).
- `spec doctor` exit-code behavior: blocking vs warning-only statuses.
- `--review-all` skip behavior on `missing_required` still exits non-zero.
- `fill-missing` behavior (only missing required keys).
- Secret-safe handling (masked prompt, secret write path, no plaintext output).
- `secret.*` spec authoring rejects plaintext-bearing metadata fields.
- Remote-root refusal for write modes.
- `cnos doctor` pointer message without replacement.

### Unit vs Integration split

- Unit: spec rule normalization, set-flag parsing, doctor issue classification.
- Integration: command handlers, manifest rewriting, runtime comparison, secret write flows, remote-root behavior.

## 8. Risks and Edge Cases

1. **Migration/compatibility risk**: expanded `SchemaRule` typing can break downstream imports if aliases are not preserved.  
   Mitigation: keep `SchemaRule` export stable; introduce additive types.

2. **YAML serialization rewrite risk**: full manifest rewrites can reorder keys and drop comments.  
   Mitigation: document current behavior, keep rewrites minimal, add regression tests for structural integrity.

3. **Scalar parsing ambiguity** (`--default`, `--example`, `--enum`): strings like `01`, `true`, `null` can coerce unexpectedly.  
   Mitigation: use JSON-first parsing for `--default` and `--example`, require non-empty JSON arrays for `--enum`, and document quoting guidance in help and docs. Help/docs must explicitly note the literal-string trap: `--default true` becomes boolean `true`; to store the string, use `--default '"true"'`. Apply the same guidance for numbers and `null`.

4. **Doctor interruption / partial progress**: interactive session may stop mid-run.  
   Mitigation: per-key atomic writes only; report applied/skipped/failed actions in summary.

5. **Secret leakage risk**: doctor prompts or JSON output could expose secret material.  
   Mitigation: masked input, no plaintext echo, no plaintext serialization.

6. **Remote-root mutation trap**: forgetting read-only guard in new write paths.  
   Mitigation: enforce `assertWritableConfigRoot` in all spec write entry points.

7. **Parser trap**: missing command-option registrations in `parseArgs.ts` can mis-route values into positional args.  
   Mitigation: add explicit parser coverage for every new spec option.

8. **CLI docs drift risk**: new top-level CLI surfaces can land without corresponding published command docs.  
   Mitigation: implementation signoff requires command help updates plus matching published CLI docs for the new `spec` command family.

9. **Masked secret input utility gap**: the codebase does not currently have a reusable masked-input helper for arbitrary secret prompts.  
   Mitigation: implement a small cross-platform masked-input utility in the CLI layer and test shell-specific behavior, especially PowerShell echo suppression, before wiring `spec doctor` secret entry flows to it.

## 9. Non-blocking Future Enhancements (Deferred)

- Structured `usedBy` identifiers instead of free-form strings.
- Non-interactive batch input mode for `spec doctor --fill-missing`.
- Full diff expansion (`cnos diff spec/workspaces/base/...`) and shared diff payloads.
- UI spec/doctor surfaces.

## 10. Implementation Completion Notes

Before feature signoff, the implementation PR must include:

1. `helpRegistry.ts` updates for the full `cnos spec` command family and any `doctor` wording changes.
2. Verification that the checked-in help surface and runtime `help-ai` surface stay aligned:
   - `cnos help`
   - `cnos help <topic>`
   - `cnos help-ai --format json`
   The implementor must update/help-align all three user-facing help surfaces whenever command behavior, flags, or descriptions change.
3. Matching published docs updates in `packages/docs` (`@kitsy/cnos-docs`) under `packages/docs/docs/cli/` for:
   - `cnos spec`
   - any subcommand pages introduced for the `spec` family
   - `cnos doctor` if its published wording changes to mention the spec-doctor pointer
4. Tests covering the mandatory approval cases listed above.

This does not expand product scope beyond Phases 1-3. It is a completion requirement so the checked-in CLI surface, runtime help surfaces, and published docs do not drift. The developer must always keep `cnos-docs`, `cnos help`, and `cnos help-ai` up to date with the implemented CLI behavior.
