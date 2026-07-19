package cnos

import (
	"encoding/json"
	"fmt"
	"time"
)

// VarSource identifies which overlay precedence tier produced a var value.
type VarSource string

const (
	VarSourceRuntime VarSource = "runtime" // active, validated runtime revision
	VarSourceStatic  VarSource = "static"  // statically projected value.<group>.<rest>
	VarSourceDefault VarSource = "default"  // schema rule default
)

// Freshness describes a runtime snapshot's position within its ttl/lease window.
// CNOS reports it; consumers decide the safety action (e.g. fail closed).
type Freshness string

const (
	FreshnessFresh   Freshness = "fresh"
	FreshnessStale   Freshness = "stale"
	FreshnessExpired Freshness = "expired"
)

// LastKnownGood records the generation/revision of the retained good snapshot
// when the current fetch state is degraded.
type LastKnownGood struct {
	Generation int64  `json:"generation"`
	Revision   string `json:"revision"`
}

// Snapshot is an immutable, validated snapshot of a single var key: its value
// plus resolution/freshness metadata. Cheap to obtain from the in-memory store
// and safe to hold per request. Returned by VarSnapshot(key) and Watch callbacks.
type Snapshot struct {
	Key            string         `json:"key"`
	Value          any            `json:"value"`
	Generation     int64          `json:"generation"`
	Revision       string         `json:"revision"`
	SchemaId       string         `json:"schemaId,omitempty"`
	EffectiveAt    string         `json:"effectiveAt,omitempty"`
	ObservedAt     time.Time      `json:"observedAt"`
	Source         VarSource      `json:"source"`
	Freshness      Freshness      `json:"freshness"`
	LeaseExpiresAt *time.Time     `json:"leaseExpiresAt,omitempty"`
	LastKnownGood  *LastKnownGood `json:"lastKnownGood,omitempty"`
}

// Decode json round-trips the snapshot value into the caller's struct/pointer.
func (snapshot Snapshot) Decode(target any) error {
	data, err := json.Marshal(snapshot.Value)
	if err != nil {
		return fmt.Errorf("cnos: encode var snapshot %q: %w", snapshot.Key, err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("cnos: decode var snapshot %q: %w", snapshot.Key, err)
	}
	return nil
}

// computeFreshness derives fresh/stale/expired from the snapshot age against the
// group's ttl (staleness threshold) and lease (fail-closed threshold).
//
// Precedence: past lease -> expired; else past the fresh window -> stale; else
// fresh. When only lease is set, lease is the fresh window (fresh until lease,
// expired after — no stale tier). When only ttl is set, ttl is the fresh window
// (fresh until ttl, stale after — no expired tier). Static/default tiers never
// expire.
func computeFreshness(source VarSource, observedAt time.Time, ttl, lease time.Duration, now time.Time) (Freshness, *time.Time) {
	if source != VarSourceRuntime {
		return FreshnessFresh, nil
	}
	age := now.Sub(observedAt)

	var leaseExpiresAt *time.Time
	if lease > 0 {
		expiry := observedAt.Add(lease)
		leaseExpiresAt = &expiry
	}

	if lease > 0 && age > lease {
		return FreshnessExpired, leaseExpiresAt
	}

	freshWindow := ttl
	if freshWindow == 0 {
		freshWindow = lease
	}
	if freshWindow > 0 && age > freshWindow {
		return FreshnessStale, leaseExpiresAt
	}
	return FreshnessFresh, leaseExpiresAt
}
