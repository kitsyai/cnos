package varrpc

import (
	"encoding/binary"
	"fmt"
)

// Hand-written protobuf wire marshal/unmarshal for the three `cnos.var.v1` messages.
//
// `protoc` is not a build prerequisite for this repo, so rather than check in generated
// code that cannot be regenerated everywhere, these three simple messages (varints and
// length-delimited fields only) are encoded directly against the protobuf wire spec.
// Byte-level cross-toolchain fixtures under `fixtures/var-cross-sdk/rpc/` pin this encoder
// against the Node (`@grpc/proto-loader`) encoder in BOTH directions, so the two can never
// silently drift. Proto3 default-value omission is honored — an empty string, a zero int64,
// empty bytes, and a false bool are not serialized — which is exactly what protobuf.js does.

// Wire types.
const (
	wireVarint  = 0
	wireFixed64 = 1
	wireBytes   = 2
	wireFixed32 = 5
)

// PullRequest is `cnos.var.v1.PullRequest`.
type PullRequest struct {
	Scope         string // field 1
	KnownRevision string // field 2
}

// SubscribeRequest is `cnos.var.v1.SubscribeRequest`.
type SubscribeRequest struct {
	Scopes []string // field 1 (repeated)
}

// SnapshotBatch is `cnos.var.v1.SnapshotBatch`. ValuesJSON carries the canonical JSON
// object keyed by the full var key minus the `var.` prefix — the same document the http
// transport puts in its `values` field.
type SnapshotBatch struct {
	Scope       string // field 1
	Generation  int64  // field 2
	Revision    string // field 3
	SchemaId    string // field 4
	EffectiveAt string // field 5
	ValuesJSON  []byte // field 6
	NotModified bool   // field 7
	NoHead      bool   // field 8
	// Cascade (field 9) is meaningful only when NoHead is true. true => CASCADING deactivation:
	// the client drops the scope AND every scope nested beneath it. false (proto3 default, omitted
	// on the wire) => EXACT-scope no_head from a reconstruction (initial sync / reconnect), so a
	// reconstruction never transiently clears a descendant it is about to restore. Live commit
	// deactivations set cascade=true; initial-sync/reconnect no_heads set cascade=false (W12).
	Cascade bool // field 9
}

// --- encoding helpers ---

func appendVarint(buf []byte, value uint64) []byte {
	return binary.AppendUvarint(buf, value)
}

func appendTag(buf []byte, field int, wireType int) []byte {
	return appendVarint(buf, uint64(field)<<3|uint64(wireType))
}

// appendString writes a length-delimited string, omitting proto3 defaults (empty).
func appendString(buf []byte, field int, value string) []byte {
	if value == "" {
		return buf
	}
	buf = appendTag(buf, field, wireBytes)
	buf = appendVarint(buf, uint64(len(value)))
	return append(buf, value...)
}

// appendBytes writes a length-delimited byte field, omitting proto3 defaults (empty).
func appendBytes(buf []byte, field int, value []byte) []byte {
	if len(value) == 0 {
		return buf
	}
	buf = appendTag(buf, field, wireBytes)
	buf = appendVarint(buf, uint64(len(value)))
	return append(buf, value...)
}

// appendInt64 writes a varint int64, omitting proto3 defaults (zero). Negative values use
// the standard 10-byte two's-complement encoding.
func appendInt64(buf []byte, field int, value int64) []byte {
	if value == 0 {
		return buf
	}
	buf = appendTag(buf, field, wireVarint)
	return appendVarint(buf, uint64(value))
}

// appendBool writes a varint bool, omitting proto3 defaults (false).
func appendBool(buf []byte, field int, value bool) []byte {
	if !value {
		return buf
	}
	buf = appendTag(buf, field, wireVarint)
	return appendVarint(buf, 1)
}

// --- decoding helpers ---

type decoder struct {
	buf []byte
	pos int
}

func (d *decoder) done() bool { return d.pos >= len(d.buf) }

func (d *decoder) varint() (uint64, error) {
	value, read := binary.Uvarint(d.buf[d.pos:])
	if read <= 0 {
		return 0, fmt.Errorf("varrpc: malformed varint at offset %d", d.pos)
	}
	d.pos += read
	return value, nil
}

func (d *decoder) bytes() ([]byte, error) {
	length, err := d.varint()
	if err != nil {
		return nil, err
	}
	end := d.pos + int(length)
	if int(length) < 0 || end > len(d.buf) {
		return nil, fmt.Errorf("varrpc: length-delimited field overruns buffer at offset %d", d.pos)
	}
	value := d.buf[d.pos:end]
	d.pos = end
	return value, nil
}

func (d *decoder) str() (string, error) {
	value, err := d.bytes()
	if err != nil {
		return "", err
	}
	return string(value), nil
}

// skip advances past a field of an unknown number, preserving forward compatibility.
func (d *decoder) skip(wireType int) error {
	switch wireType {
	case wireVarint:
		_, err := d.varint()
		return err
	case wireBytes:
		_, err := d.bytes()
		return err
	case wireFixed64:
		if d.pos+8 > len(d.buf) {
			return fmt.Errorf("varrpc: fixed64 overruns buffer at offset %d", d.pos)
		}
		d.pos += 8
		return nil
	case wireFixed32:
		if d.pos+4 > len(d.buf) {
			return fmt.Errorf("varrpc: fixed32 overruns buffer at offset %d", d.pos)
		}
		d.pos += 4
		return nil
	default:
		return fmt.Errorf("varrpc: unsupported wire type %d at offset %d", wireType, d.pos)
	}
}

func (d *decoder) tag() (int, int, error) {
	key, err := d.varint()
	if err != nil {
		return 0, 0, err
	}
	return int(key >> 3), int(key & 7), nil
}

// --- PullRequest ---

// Marshal encodes the message in protobuf wire format.
func (message *PullRequest) Marshal() []byte {
	var buf []byte
	buf = appendString(buf, 1, message.Scope)
	buf = appendString(buf, 2, message.KnownRevision)
	return buf
}

// Unmarshal decodes the message from protobuf wire format.
func (message *PullRequest) Unmarshal(data []byte) error {
	*message = PullRequest{}
	d := &decoder{buf: data}
	for !d.done() {
		field, wireType, err := d.tag()
		if err != nil {
			return err
		}
		switch {
		case field == 1 && wireType == wireBytes:
			if message.Scope, err = d.str(); err != nil {
				return err
			}
		case field == 2 && wireType == wireBytes:
			if message.KnownRevision, err = d.str(); err != nil {
				return err
			}
		default:
			if err := d.skip(wireType); err != nil {
				return err
			}
		}
	}
	return nil
}

// --- SubscribeRequest ---

func (message *SubscribeRequest) Marshal() []byte {
	var buf []byte
	for _, scope := range message.Scopes {
		// A repeated string is one length-delimited entry per element; an empty element is
		// still an element, so it is written explicitly rather than omitted.
		buf = appendTag(buf, 1, wireBytes)
		buf = appendVarint(buf, uint64(len(scope)))
		buf = append(buf, scope...)
	}
	return buf
}

func (message *SubscribeRequest) Unmarshal(data []byte) error {
	*message = SubscribeRequest{}
	d := &decoder{buf: data}
	for !d.done() {
		field, wireType, err := d.tag()
		if err != nil {
			return err
		}
		switch {
		case field == 1 && wireType == wireBytes:
			scope, err := d.str()
			if err != nil {
				return err
			}
			message.Scopes = append(message.Scopes, scope)
		default:
			if err := d.skip(wireType); err != nil {
				return err
			}
		}
	}
	return nil
}

// --- SnapshotBatch ---

func (message *SnapshotBatch) Marshal() []byte {
	var buf []byte
	buf = appendString(buf, 1, message.Scope)
	buf = appendInt64(buf, 2, message.Generation)
	buf = appendString(buf, 3, message.Revision)
	buf = appendString(buf, 4, message.SchemaId)
	buf = appendString(buf, 5, message.EffectiveAt)
	buf = appendBytes(buf, 6, message.ValuesJSON)
	buf = appendBool(buf, 7, message.NotModified)
	buf = appendBool(buf, 8, message.NoHead)
	buf = appendBool(buf, 9, message.Cascade)
	return buf
}

func (message *SnapshotBatch) Unmarshal(data []byte) error {
	*message = SnapshotBatch{}
	d := &decoder{buf: data}
	for !d.done() {
		field, wireType, err := d.tag()
		if err != nil {
			return err
		}
		switch {
		case field == 1 && wireType == wireBytes:
			if message.Scope, err = d.str(); err != nil {
				return err
			}
		case field == 2 && wireType == wireVarint:
			value, err := d.varint()
			if err != nil {
				return err
			}
			message.Generation = int64(value)
		case field == 3 && wireType == wireBytes:
			if message.Revision, err = d.str(); err != nil {
				return err
			}
		case field == 4 && wireType == wireBytes:
			if message.SchemaId, err = d.str(); err != nil {
				return err
			}
		case field == 5 && wireType == wireBytes:
			if message.EffectiveAt, err = d.str(); err != nil {
				return err
			}
		case field == 6 && wireType == wireBytes:
			value, err := d.bytes()
			if err != nil {
				return err
			}
			message.ValuesJSON = append([]byte(nil), value...)
		case field == 7 && wireType == wireVarint:
			value, err := d.varint()
			if err != nil {
				return err
			}
			message.NotModified = value != 0
		case field == 8 && wireType == wireVarint:
			value, err := d.varint()
			if err != nil {
				return err
			}
			message.NoHead = value != 0
		case field == 9 && wireType == wireVarint:
			value, err := d.varint()
			if err != nil {
				return err
			}
			message.Cascade = value != 0
		default:
			if err := d.skip(wireType); err != nil {
				return err
			}
		}
	}
	return nil
}
