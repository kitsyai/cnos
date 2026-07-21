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

// varScopeEntry is one scope's WHOLE committed batch. The store keys entries by scope, not
// by var key, because a revision REPLACES its scope: a key present in revision 1 and absent
// from revision 2 must stop being served. Merging per-key updates instead — which is what the
// store used to do — kept serving a removed allowlist entry or a revoked policy flag forever.
type varScopeEntry struct {
	scope   string
	group   string
	records map[string]*varRecord // keyed by the FULL var key ("var.agentic.lanes.vinci")
}

type varStoreState struct {
	scopes map[string]*varScopeEntry
}

// find returns the entry that serves fullKey: the LONGEST committed scope that is a dot-prefix
// of (or equal to) the key. Only that entry is consulted — a key missing from it does NOT fall
// through to a broader scope, so a narrower scope fully shadows the range it owns. Canonical
// rule, identical to the Node LiveVarStore.findScope.
func (state *varStoreState) find(fullKey string) *varScopeEntry {
	path := strings.TrimPrefix(fullKey, "var.")
	segments := strings.Split(path, ".")
	for i := len(segments); i >= 1; i-- {
		if entry, ok := state.scopes[strings.Join(segments[:i], ".")]; ok {
			return entry
		}
	}
	return nil
}

// varStore holds immutable per-scope snapshot batches behind a single atomic
// pointer. Reads are lock-free and always observe a complete, consistent map.
// A batch commit builds a whole new map and swaps the pointer once, so
// concurrent readers never see a mixed (partially applied) state.
type varStore struct {
	state atomic.Pointer[varStoreState]
}

func newVarStore() *varStore {
	store := &varStore{}
	store.state.Store(&varStoreState{scopes: map[string]*varScopeEntry{}})
	return store
}

func (store *varStore) get(key string) (*varRecord, bool) {
	entry := store.state.Load().find(key)
	if entry == nil {
		return nil, false
	}
	record, ok := entry.records[key]
	return record, ok
}

// scopeKeys returns the var keys currently OWNED by scope (the keys its last committed
// revision carried). Used to compute what a replacement revision displaces.
func (store *varStore) scopeKeys(scope string) []string {
	entry, ok := store.state.Load().scopes[scope]
	if !ok {
		return nil
	}
	result := make([]string, 0, len(entry.records))
	for key := range entry.records {
		result = append(result, key)
	}
	return result
}

// commit atomically REPLACES the scope's batch. The whole map is copied-on-write and swapped
// in a single CAS, so the batch is one transaction: readers see either the entire old set or
// the entire new set, and every key the previous revision carried but this one omits stops
// being served (falling back through the overlay to ② static / ③ default).
//
// Other scopes are untouched — an independently authored narrower scope ("g.a") survives a
// commit of the broader scope ("g"), matching the Node store exactly.
func (store *varStore) commit(scope, group string, updates map[string]*varRecord) {
	entry := &varScopeEntry{scope: scope, group: group, records: updates}
	for {
		old := store.state.Load()
		next := make(map[string]*varScopeEntry, len(old.scopes)+1)
		for key, existing := range old.scopes {
			next[key] = existing
		}
		next[scope] = entry
		if store.state.CompareAndSwap(old, &varStoreState{scopes: next}) {
			return
		}
	}
}

// removeScope atomically drops every committed scope belonging to scope — the scope itself and
// everything nested beneath it ("<scope>.…") — and returns the var keys it removed. Like
// commit, it copies the whole map and swaps it with a single CAS, so a concurrent reader
// observes either all of the scope's keys or none of them, never a half-removed state.
//
// This is the deactivation path: the authority definitively answered "no active head" for the
// scope, so the runtime tier must go and the overlay must fall back to ② static / ③ default. A
// TRANSPORT FAILURE IS NOT A NO-HEAD and must never reach here — an unreachable remote keeps
// last-known-good. Returns nil when nothing was applied (idempotent no-op).
func (store *varStore) removeScope(scope string) []string {
	for {
		old := store.state.Load()
		removed := make([]string, 0)
		next := make(map[string]*varScopeEntry, len(old.scopes))
		for key, entry := range old.scopes {
			if key == scope || strings.HasPrefix(key, scope+".") {
				for recordKey := range entry.records {
					removed = append(removed, recordKey)
				}
				continue
			}
			next[key] = entry
		}
		if len(removed) == 0 {
			return nil
		}
		if store.state.CompareAndSwap(old, &varStoreState{scopes: next}) {
			return removed
		}
	}
}

// keys returns the current set of committed var keys across every scope.
func (store *varStore) keys() []string {
	scopes := store.state.Load().scopes
	result := make([]string, 0, len(scopes))
	for _, entry := range scopes {
		for key := range entry.records {
			result = append(result, key)
		}
	}
	return result
}
