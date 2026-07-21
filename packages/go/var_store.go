package cnos

import (
	"strings"
	"sync/atomic"
	"time"
)

// varRecord is an immutable committed snapshot plus the group's freshness window
// inputs. Records are never mutated after commit; a new record replaces the old
// one via an atomic map swap. Freshness/LeaseExpiresAt are computed at read time
// (they depend on wall-clock now), everything else is fixed at commit time.
type varRecord struct {
	base  Snapshot // Freshness/LeaseExpiresAt left zero; filled per read
	ttl   time.Duration
	lease time.Duration
	// leaseSet records whether the group DECLARED a lease at all. An absent lease never
	// expires; a declared `lease: 0` expires immediately (cross-SDK canonical).
	leaseSet bool
}

// snapshot returns the record's snapshot with freshness computed against now.
func (record *varRecord) snapshot(now time.Time) Snapshot {
	result := record.base
	result.Freshness, result.LeaseExpiresAt = computeFreshness(result.Source, result.ObservedAt, record.ttl, record.lease, record.leaseSet, now)
	return result
}

type varStoreState struct {
	records map[string]*varRecord
}

// varStore holds immutable per-key snapshot records behind a single atomic
// pointer. Reads are lock-free and always observe a complete, consistent map.
// A batch commit builds a whole new map and swaps the pointer once, so
// concurrent readers never see a mixed (partially applied) state.
type varStore struct {
	state atomic.Pointer[varStoreState]
}

func newVarStore() *varStore {
	store := &varStore{}
	store.state.Store(&varStoreState{records: map[string]*varRecord{}})
	return store
}

func (store *varStore) get(key string) (*varRecord, bool) {
	record, ok := store.state.Load().records[key]
	return record, ok
}

// commit atomically replaces the records for the given keys. The whole map is
// copied-on-write and swapped in a single atomic operation, so the batch is one
// transaction: readers see either the entire old set or the entire new set.
func (store *varStore) commit(updates map[string]*varRecord) {
	for {
		old := store.state.Load()
		next := make(map[string]*varRecord, len(old.records)+len(updates))
		for key, record := range old.records {
			next[key] = record
		}
		for key, record := range updates {
			next[key] = record
		}
		if store.state.CompareAndSwap(old, &varStoreState{records: next}) {
			return
		}
	}
}

// removeScope atomically drops every committed key belonging to scope — the scope itself
// ("var.<scope>") and everything nested beneath it ("var.<scope>.…") — and returns the keys it
// removed. Like commit, it copies the whole map and swaps it with a single CAS, so a concurrent
// reader observes either all of the scope's keys or none of them, never a half-removed state.
//
// This is the deactivation path: the authority definitively answered "no active head" for the
// scope, so the runtime tier must go and the overlay must fall back to ② static / ③ default. A
// TRANSPORT FAILURE IS NOT A NO-HEAD and must never reach here — an unreachable remote keeps
// last-known-good. Returns nil when nothing was applied (idempotent no-op).
func (store *varStore) removeScope(scope string) []string {
	prefix := "var." + scope
	for {
		old := store.state.Load()
		removed := make([]string, 0)
		next := make(map[string]*varRecord, len(old.records))
		for key, record := range old.records {
			if key == prefix || strings.HasPrefix(key, prefix+".") {
				removed = append(removed, key)
				continue
			}
			next[key] = record
		}
		if len(removed) == 0 {
			return nil
		}
		if store.state.CompareAndSwap(old, &varStoreState{records: next}) {
			return removed
		}
	}
}

// keys returns the current set of committed var keys.
func (store *varStore) keys() []string {
	records := store.state.Load().records
	result := make([]string, 0, len(records))
	for key := range records {
		result = append(result, key)
	}
	return result
}
