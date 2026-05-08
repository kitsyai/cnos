# Reviewer Skill

You are reviewing code changes for CNOS.

## Review Checklist

### 1. Correctness
- Does the code do what the spec says? Cross-reference against test suite spec IDs.
- Does it handle the error cases? Missing key, missing vault, invalid expression, cycle.
- Are edge cases covered? Empty string, null, unicode, type preservation.

### 2. Security
- Any path where `secret.*` could reach `toPublicEnv()`, browser data, or CLI output without `--reveal`?
- Any new CLI args that accept sensitive values (passphrases, tokens)? Must use env var or prompt instead.
- Any plaintext secret in logs, error messages, or serialized state?
- Does promotion safety check dependencies transitively through derived values?
- Does the code respect namespace `sensitive` and `shareable` flags?

### 3. Caching
- Config-only derived values: cached per resolution pass? Not re-evaluated on every read?
- Runtime-dependent derived values: evaluated fresh every time? Never cached?
- Secret cache: per-runtime instance, not global static?
- Remote root cache: immutable refs cached permanently, mutable refs respect TTL?

### 4. Types
- Are interfaces explicit? Any `any` without justification comment?
- Are return types declared on exported functions (not inferred)?
- Do new types match the patterns in `ARCHITECTURE.md`?

### 5. Errors
- Are error messages actionable? Do they include the key/file/vault involved?
- Do errors tell the user what to do next?
- Are typed error classes used (`CnosSecurityError`, `CnosAuthenticationError`, etc.)?
- No swallowed errors?

### 6. Tests
- Are there tests for the change?
- Do tests use spec IDs where they exist?
- Are negative cases tested (the bad thing does NOT happen)?
- Are edge cases covered?

### 7. Conventions
- Does the code match `.agents/CONVENTIONS.md`?
- File naming? Type naming? Function naming?
- Is the module in the right directory per `ARCHITECTURE.md`?

### 8. Public API
- Any new exports from `index.ts`? Are they documented with JSDoc?
- Any changed function signatures? Backward compatible?
- Any new CLI flags? Documented in help text and docs?

### 9. Dependencies
- Any new npm deps? Were they approved? Could a Node.js built-in do the job?

### 10. Projection consistency
- If the change affects how values are resolved, does it work correctly in:
  - `toEnv()` output?
  - `toPublicEnv()` output?
  - `toServerProjection()` output?
  - Browser runtime reads?
  - CLI reads?

## Review Output Format

For each issue:
- **Severity:** blocker / warning / nit
- **Location:** file and line (or function name)
- **What's wrong:** concrete description
- **Suggested fix:** what to change
