# var.* cross-SDK wire fixtures

Canonical wire-shape fixtures for the `var.*` runtime-variables feature, asserted
**parse-equivalent in both toolchains** so the TypeScript server/SDK and the Go SDK can
never silently drift:

- TypeScript: `packages/core/test/cross-sdk-wire.test.ts`
- Go: `packages/go/var_crosssdk_test.go`

| File | Shape | Notes |
|------|-------|-------|
| `projection.json` | `toServerProjection` var blocks (`varSources`, `vars`, `documents`, `schema`) | `schema` is keyed by the full var key; `default` present only when declared |
| `pull-response.json` | http pull `200` body `{ generation, revision, schemaId?, effectiveAt, values }` | GROUP scope; `values` keyed by full stripped key |
| `push-payload.json` | receiver push body `{ revision?, generation?, schemaId?, effectiveAt?, values }` | GROUP scope; `values` keyed by full stripped key |

`projection.json`'s var blocks are the byte-for-byte output of `toServerProjection` for the
manifest documented in the TS test. If you change either SDK's wire shape, update these
files and both tests together.
