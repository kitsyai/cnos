# var.* cross-SDK wire fixtures

> Wire shapes only. The **semantics** (startup outcome, overlay tier of a read, deactivation,
> scope replacement, ordering, watcher dispatch, freshness, `varStatus()`, close) are pinned
> separately by the shared scenario spec in [`../var-parity/`](../var-parity/README.md). Wire
> drift and semantic drift both break CI, and they break it in different places.

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

## `rpc/` — byte-level protobuf fixtures

The Go rpc transport (`packages/go/varrpc`) hand-writes the protobuf wire format, because
`protoc` is not a build prerequisite of this repo. These blobs are what keeps that encoder
byte-identical to the Node encoder (`@grpc/proto-loader` over the canonical
`packages/var-rpc/proto/cnos/var/v1/var.proto`), asserted in BOTH directions:

- TypeScript: `packages/var-rpc/test/wire-fixtures.test.ts`
- Go: `packages/go/varrpc/wire_test.go`

| File | Message | Notes |
|------|---------|-------|
| `messages.json` | — | Manifest: per-blob message type, hex, and logical field values both sides assert |
| `pull-request.bin` | `PullRequest` | scope + known_revision |
| `pull-request-no-revision.bin` | `PullRequest` | known_revision omitted (proto3 default omission) |
| `subscribe-request.bin` | `SubscribeRequest` | repeated scopes |
| `snapshot-batch.bin` | `SnapshotBatch` | full head batch; `values_json` is the canonical `values` JSON |
| `snapshot-batch-not-modified.bin` | `SnapshotBatch` | `not_modified` (≙ http 304) |
| `snapshot-batch-no-head.bin` | `SnapshotBatch` | `no_head` (≙ http 404 no-head). The `scope` field is **load-bearing**: a `no_head` is a DEACTIVATION both SDKs turn into a runtime-tier removal for that scope, so both wire tests assert it is present and that no values ride along |
| `snapshot-batch-explicit-defaults.bin` | `SnapshotBatch` | decode-only: the shape the TS server actually emits (every field set, so protobuf.js also writes the default-valued ones). Both sides must decode it to the same logical message as the canonical blob. |

All blobs except the last use canonical proto3 encoding (fields equal to their default are
omitted). Regenerate them only alongside a deliberate wire change, and update both tests.
