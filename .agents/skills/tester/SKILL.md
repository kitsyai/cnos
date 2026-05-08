# Tester Skill

You are writing and maintaining tests for CNOS.

## Test Framework

- vitest
- Run all: `pnpm test`
- Run specific: `pnpm test src/derive/evaluator.test.ts`
- Coverage: `pnpm test --coverage`

## Test Structure

- Unit tests: alongside source — `evaluator.ts` → `evaluator.test.ts`
- Integration tests: `__tests__/integration/`
- Golden/snapshot tests: `__tests__/golden/`

## Test ID System

The CNOS test suite spec assigns stable IDs to every test. Use these IDs in test descriptions when they exist. Test areas and their prefixes:

| Prefix | Area |
|--------|------|
| MF | Manifest loading |
| WS | Workspace resolution |
| PF | Profile resolution |
| LD | Loaders |
| RS | Resolution/precedence |
| VL | Validation |
| IN | Inspection/provenance |
| NS | Namespace/promotion |
| EX | Export/projection |
| RT | Singleton runtime |
| BR | Browser runtime |
| CR | cnos run |
| CD | cnos define |
| CI | cnos init |
| CG | Codegen |
| CW | Watch |
| CM | Migrate |
| DR | Drift |
| VT | Vault |
| DRV-A | Derived values: authoring |
| DRV-T | Derived values: template parsing |
| DRV-E | Derived values: expression parsing |
| DRV-V | Derived values: evaluation/caching |
| DRV-R | Derived values: runtime namespaces |
| DRV-PR | Derived values: projections |
| DRV-S | Derived values: promotion safety |
| SEC | Security invariants |
| BATCH | Secret batch resolution |
| AUTH | Auth resolution |
| LV | Local vault |
| DISC | Discovery |
| PROJ | Server projection |
| IG | Integration |
| ED | Edge cases |

Example:

```ts
describe("evaluator", () => {
  it("DRV-V-1: simple derived value resolves at read time", () => {
    // ...
  });
  
  it("DRV-V-4: cycle (a → b → a) throws CnosDerivedCycleError with chain", () => {
    // ...
  });

  it("DRV-V-9: config-only derivation cached across reads", () => {
    // Call read twice. Evaluator should be called once.
  });

  it("DRV-V-10: runtime-dependent derivation NOT cached between reads", () => {
    // Read, change process.env.PORT, read again. Values should differ.
  });
});
```

## Security Tests

Security invariant tests (SEC-*) must verify the **negative case** — the bad thing does NOT happen:

```ts
it("SEC-3: secret.* never in toPublicEnv()", () => {
  // Setup: secret.db.password exists, somehow in promote list
  // Assert: toPublicEnv() throws CnosSecurityError or omits the key
  // The secret value must NOT appear in the output under any circumstance
});
```

## Edge Case Tests

Cover these patterns for every data-handling module:
- Empty string (`""`) — must return `""`, not undefined
- Null — must return `null`, not undefined
- Undefined — must return undefined
- Unicode values — `"こんにちは"` preserved
- Very long values — 10K+ chars, no truncation
- Type preservation — number stays number, boolean stays boolean, not coerced to string
- Special characters in env export — `=`, newlines, quotes

## Testing Derived Values

Critical caching tests (DRV-V-9 and DRV-V-10):

```ts
it("DRV-V-9: config-only derivation cached across reads", () => {
  // Setup: value.app.origin derives from value.app.host + value.app.port
  // Read value.app.origin twice
  // Assert: evaluator function called exactly once (cached after first eval)
});

it("DRV-V-10: runtime-dependent derivation NOT cached", () => {
  // Setup: value.app.port derives from coalesce(process.env.PORT, '3000')
  // Set process.env.PORT = "8080", read → expect "8080"
  // Set process.env.PORT = "9090", read → expect "9090"
  // Values must differ — no caching for runtime-dependent derivations
});
```

## Testing Secret Security

```ts
it("SEC-11: bootstrap env payloads do not contain decrypted secrets", () => {
  // Setup: cnos run spawns child
  // Assert: parse __CNOS_PROJECTION__ and __CNOS_GRAPH__ from child env
  // serialized secret data must remain refs/metadata, never plaintext values
  // No string values that match actual secret plaintext
});
```

## Rules

- Never modify application code to make a test pass. Report the failure for triage.
- If you believe a test spec is wrong, explain why in the triage report.
- All new public methods must have tests before the PR is considered complete.
