package varrpc

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// Byte-level cross-toolchain fixtures. Because this module hand-writes the protobuf wire
// format (protoc is not a build prerequisite), these fixtures are the contract that keeps it
// byte-identical to the Node encoder in `@grpc/proto-loader`:
//
//	fixtures/var-cross-sdk/rpc/*.bin   — produced by Node from the canonical .proto
//	fixtures/var-cross-sdk/rpc/messages.json — the logical field values for each blob
//
// Its twin is `packages/var-rpc/test/wire-fixtures.test.ts`, which asserts the SAME files
// from the Node side. If the wire shape changes, both tests move together.

const fixtureDir = "../../../fixtures/var-cross-sdk/rpc"

type fixtureValue struct {
	Scope          string   `json:"scope"`
	KnownRevision  string   `json:"known_revision"`
	Scopes         []string `json:"scopes"`
	Generation     string   `json:"generation"`
	Revision       string   `json:"revision"`
	SchemaId       string   `json:"schema_id"`
	EffectiveAt    string   `json:"effective_at"`
	ValuesJSONUTF8 string   `json:"values_json_utf8"`
	NotModified    bool     `json:"not_modified"`
	NoHead         bool     `json:"no_head"`
	ExactScope     bool     `json:"exact_scope"`
}

type fixtureEntry struct {
	File       string       `json:"file"`
	Message    string       `json:"message"`
	DecodeOnly bool         `json:"decodeOnly"`
	Hex        string       `json:"hex"`
	Value      fixtureValue `json:"value"`
}

func loadFixtures(t *testing.T) []fixtureEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, "messages.json"))
	if err != nil {
		t.Fatalf("read fixture manifest: %v", err)
	}
	var entries []fixtureEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("parse fixture manifest: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("fixture manifest is empty")
	}
	return entries
}

func (value fixtureValue) generation(t *testing.T) int64 {
	t.Helper()
	if value.Generation == "" {
		return 0
	}
	parsed, err := strconv.ParseInt(value.Generation, 10, 64)
	if err != nil {
		t.Fatalf("parse generation %q: %v", value.Generation, err)
	}
	return parsed
}

func TestWireFixturesMatchNodeEncoder(t *testing.T) {
	for _, entry := range loadFixtures(t) {
		t.Run(entry.File, func(t *testing.T) {
			bytes, err := os.ReadFile(filepath.Join(fixtureDir, entry.File))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			if got := hex.EncodeToString(bytes); got != entry.Hex {
				t.Fatalf("fixture blob disagrees with its manifest hex:\n got %s\nwant %s", got, entry.Hex)
			}

			switch entry.Message {
			case "PullRequest":
				message := &PullRequest{Scope: entry.Value.Scope, KnownRevision: entry.Value.KnownRevision}

				if !entry.DecodeOnly {
					if got := hex.EncodeToString(message.Marshal()); got != entry.Hex {
						t.Errorf("Go encode differs from Node:\n got %s\nwant %s", got, entry.Hex)
					}
				}

				decoded := &PullRequest{}
				if err := decoded.Unmarshal(bytes); err != nil {
					t.Fatalf("decode: %v", err)
				}
				if decoded.Scope != message.Scope || decoded.KnownRevision != message.KnownRevision {
					t.Errorf("decode mismatch: got %+v, want %+v", decoded, message)
				}

			case "SubscribeRequest":
				message := &SubscribeRequest{Scopes: entry.Value.Scopes}

				if !entry.DecodeOnly {
					if got := hex.EncodeToString(message.Marshal()); got != entry.Hex {
						t.Errorf("Go encode differs from Node:\n got %s\nwant %s", got, entry.Hex)
					}
				}

				decoded := &SubscribeRequest{}
				if err := decoded.Unmarshal(bytes); err != nil {
					t.Fatalf("decode: %v", err)
				}
				if len(decoded.Scopes) != len(message.Scopes) {
					t.Fatalf("decode mismatch: got %v, want %v", decoded.Scopes, message.Scopes)
				}
				for i := range decoded.Scopes {
					if decoded.Scopes[i] != message.Scopes[i] {
						t.Errorf("scope[%d]: got %q, want %q", i, decoded.Scopes[i], message.Scopes[i])
					}
				}

			case "SnapshotBatch":
				message := &SnapshotBatch{
					Scope:       entry.Value.Scope,
					Generation:  entry.Value.generation(t),
					Revision:    entry.Value.Revision,
					SchemaId:    entry.Value.SchemaId,
					EffectiveAt: entry.Value.EffectiveAt,
					ValuesJSON:  []byte(entry.Value.ValuesJSONUTF8),
					NotModified: entry.Value.NotModified,
					NoHead:      entry.Value.NoHead,
					ExactScope:  entry.Value.ExactScope,
				}

				if !entry.DecodeOnly {
					if got := hex.EncodeToString(message.Marshal()); got != entry.Hex {
						t.Errorf("Go encode differs from Node:\n got %s\nwant %s", got, entry.Hex)
					}
				}

				decoded := &SnapshotBatch{}
				if err := decoded.Unmarshal(bytes); err != nil {
					t.Fatalf("decode: %v", err)
				}
				if decoded.Scope != message.Scope ||
					decoded.Generation != message.Generation ||
					decoded.Revision != message.Revision ||
					decoded.SchemaId != message.SchemaId ||
					decoded.EffectiveAt != message.EffectiveAt ||
					string(decoded.ValuesJSON) != string(message.ValuesJSON) ||
					decoded.NotModified != message.NotModified ||
					decoded.NoHead != message.NoHead ||
					decoded.ExactScope != message.ExactScope {
					t.Errorf("decode mismatch:\n got %+v\nwant %+v", decoded, message)
				}

			default:
				t.Fatalf("unknown fixture message type %q", entry.Message)
			}
		})
	}
}

// The TypeScript server sets every field explicitly, so protobuf.js also emits the
// default-valued ones. Go must decode that to the SAME logical message as the canonical,
// default-omitting encoding — otherwise real Go-client ↔ TS-server traffic would diverge.
func TestExplicitDefaultsDecodeToCanonicalMessage(t *testing.T) {
	read := func(name string) *SnapshotBatch {
		t.Helper()
		bytes, err := os.ReadFile(filepath.Join(fixtureDir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		batch := &SnapshotBatch{}
		if err := batch.Unmarshal(bytes); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		return batch
	}

	canonical := read("snapshot-batch-no-head.bin")
	explicit := read("snapshot-batch-explicit-defaults.bin")

	if canonical.Scope != explicit.Scope || canonical.NoHead != explicit.NoHead ||
		canonical.Generation != explicit.Generation || canonical.Revision != explicit.Revision ||
		canonical.NotModified != explicit.NotModified || len(explicit.ValuesJSON) != 0 {
		t.Fatalf("explicit-defaults decode diverged:\n got %+v\nwant %+v", explicit, canonical)
	}

	// `no_head` is a DEACTIVATION, not a no-op: both SDKs turn it into a runtime-tier removal for
	// `scope`, so the scope field is the only thing identifying what to clear. A no_head message
	// with an empty scope is unactionable. Pinned here and in
	// `packages/var-rpc/test/wire-fixtures.test.ts` so neither encoder can drop it.
	for _, batch := range []*SnapshotBatch{canonical, explicit} {
		if !batch.NoHead {
			t.Fatalf("expected a no_head message, got %+v", batch)
		}
		if batch.Scope != "agentic" {
			t.Fatalf("a no_head message must carry the scope it deactivates, got %q", batch.Scope)
		}
		if len(batch.ValuesJSON) != 0 {
			t.Fatalf("a no_head message must carry no values, got %q", batch.ValuesJSON)
		}
	}
}

func TestRoundTripAndUnknownFieldSkipping(t *testing.T) {
	original := &SnapshotBatch{
		Scope:       "user",
		Generation:  1 << 40,
		Revision:    "sha256:deadbeef",
		SchemaId:    "coupon/v2",
		EffectiveAt: "2026-07-20T01:02:03.000Z",
		ValuesJSON:  []byte(`{"user.IN.coupon_allowed":true}`),
	}

	encoded := original.Marshal()

	// Append an unknown field 15 (varint) and an unknown field 16 (length-delimited); a
	// forward-compatible decoder must skip both without error.
	encoded = append(encoded, 0x78, 0x2a)                 // field 15, varint 42
	encoded = append(encoded, 0x82, 0x01, 0x02, 'h', 'i') // field 16, bytes "hi"

	decoded := &SnapshotBatch{}
	if err := decoded.Unmarshal(encoded); err != nil {
		t.Fatalf("decode with unknown fields: %v", err)
	}

	if decoded.Scope != original.Scope || decoded.Generation != original.Generation ||
		decoded.Revision != original.Revision || decoded.SchemaId != original.SchemaId ||
		decoded.EffectiveAt != original.EffectiveAt ||
		string(decoded.ValuesJSON) != string(original.ValuesJSON) {
		t.Fatalf("round trip diverged:\n got %+v\nwant %+v", decoded, original)
	}
}
