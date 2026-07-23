package cnos

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ErrVarRequired is returned (wrapped) when a required var cannot be resolved
// from any tier during Ready/refresh — fail fast, never nil-and-continue.
var ErrVarRequired = errors.New("cnos: required var unavailable")

// ErrVarClosed is returned by StartVars when the var runtime is (or becomes) closed. A closed
// runtime can never become ready, so reporting success would hand the caller a runtime with no
// pollers, no subscriptions and no providers, silently serving only the static/default tiers.
// The Node SDK throws the equivalent error from VarManager.start().
var ErrVarClosed = errors.New("cnos: var runtime is closed")

// varWatcher is a single registered watch callback with its key/prefix matcher.
type varWatcher struct {
	match func(key string) bool
	fn    func(next, prev Snapshot)
}

// varScopeStatus holds per-scope (per-group) fetch metadata for observability.
// It never holds var values or secret material.
type varScopeStatus struct {
	desiredGeneration *int64
	revision          string
	lastRefreshAt     time.Time
	lastError         string
	lastRejected      *VarRejection
	subscription      *VarSubscriptionStatus
}

// Var subscription lifecycle states, mirroring the TypeScript VarSubscriptionState.
const (
	VarSubscriptionActive   = "active"
	VarSubscriptionRetrying = "retrying"
	VarSubscriptionFailed   = "failed"
)

// VarSubscriptionStatus is the observable state of a source's push subscription.
// "failed" is TERMINAL: the transport provider has stopped reconnecting (an
// authentication/permission rejection, or the consecutive-failure cap was reached)
// and the scope receives no further pushes until the process re-subscribes.
type VarSubscriptionStatus struct {
	State     string `json:"state"`
	LastError string `json:"lastError,omitempty"`
	Attempts  int    `json:"attempts,omitempty"`
	At        string `json:"at,omitempty"`
}

// VarRejection records the last rejected revision, why, and when. `At` is an ISO-8601
// timestamp, matching the Node SDK's `lastRejected: { revision, reason, at }` shape.
type VarRejection struct {
	Revision string `json:"revision"`
	Reason   string `json:"reason"`
	At       string `json:"at"`
}

// VarStatusEntry is the per-scope observability document. It carries only
// value-free metadata (revision hashes, generations, freshness) — never secret
// material or full sensitive documents.
type VarStatusEntry struct {
	DesiredGeneration *int64        `json:"desiredGeneration,omitempty"`
	AppliedGeneration int64         `json:"appliedGeneration"`
	Revision          string        `json:"revision,omitempty"`
	Source            VarSource     `json:"source"`
	SnapshotAge       float64       `json:"snapshotAge"`
	Freshness         Freshness     `json:"freshness"`
	LastRefreshAt     string        `json:"lastRefreshAt,omitempty"`
	LastError         string        `json:"lastError,omitempty"`
	LastRejected      *VarRejection `json:"lastRejected,omitempty"`
	// Subscription is the push-subscription state for this key's source, when a
	// subscribing transport (e.g. rpc) is in use.
	Subscription *VarSubscriptionStatus `json:"subscription,omitempty"`
}

// varRuntime owns the live var store, fetch/watch/poll machinery, and lifecycle
// for a single Runtime. Consuming services write zero transport or polling code.
type varRuntime struct {
	runtime    *Runtime
	sources    map[string]VarSourceDef
	groups     map[string]VarGroupDef
	documents  map[string]DocumentSchema
	rules      map[string]VarKeyRule
	store      *varStore
	httpClient *http.Client

	// Registered transport provider factories keyed by transport name, plus the lazily
	// constructed providers and their live subscriptions. The core module ships the http
	// client only; rpc/ws/sse arrive as registered factories from their own submodules.
	varFactories  map[string]VarSourceProviderFactory
	providers     map[string]VarSourceProvider
	subscriptions []func()

	mu        sync.Mutex
	watchers  map[int]*varWatcher
	nextWatch int
	status    map[string]*varScopeStatus
	inflight  map[string]bool
	// warnedPollInterval dedupes the "pollInterval ignored on a subscribe-capable source" warning.
	warnedPollInterval map[string]bool
	ctx                context.Context
	cancel             context.CancelFunc
	closed             bool
	// startAttempt is the in-flight (or completed-successfully) startup attempt. Concurrent
	// StartVars callers block on its done channel and share its result instead of racing.
	startAttempt *varStartAttempt

	// applyMu serializes every AUTHORITATIVE application (an accepted ingest or a no-head
	// removal) together with its epoch check and its notification enqueue, so a pull cannot
	// slip its commit in between a push's epoch bump and that push's commit. It is never held
	// across a watcher callback — dispatch happens outside, off the queue below.
	applyMu sync.Mutex
	// epochs is the monotonic per-scope operation counter (guarded by applyMu). A pull captures
	// it before issuing its request and applies only when it is unchanged on completion.
	epochs map[string]uint64

	// notifyMu guards the committed-but-undispatched watcher events and the dispatch latch.
	notifyMu    sync.Mutex
	notifyQueue []varNotifyEvent
	dispatching bool
}

// varNotifyEntry is ONE frozen watcher delivery: both snapshots are captured around the
// mutation that produced them and never re-read at dispatch time. Re-reading is what let a
// reactivation triggered from inside a deactivation callback show the reactivated value to the
// watchers visited later in the same pass, which never saw the fallback transition at all.
type varNotifyEntry struct {
	key     string
	next    Snapshot
	prev    Snapshot
	hasPrev bool
}

// varNotifyEvent is one commit's complete delivery list plus the watcher registry frozen at
// commit time. Events are dispatched strictly in commit order, one fully before the next.
type varNotifyEvent struct {
	watcherIDs []int
	entries    []varNotifyEntry
}

// varStartAttempt is one shared startup attempt. `err` is written before `done` is closed, so
// every waiter that observes the close also observes the final error (happens-before via the
// channel), which is what lets concurrent callers agree on a single outcome.
type varStartAttempt struct {
	done chan struct{}
	err  error
}

// initVars builds the var runtime from the projection's optional var blocks and
// registers "var" as a runtime namespace so derived formulas referencing var.*
// are treated as runtime-dependent (never cached), mirroring process.*. Safe to
// call with an empty projection (no var blocks → inert var runtime).
func (runtime *Runtime) initVars(projection ServerProjection) {
	ctx, cancel := context.WithCancel(context.Background())
	variables := &varRuntime{
		runtime:      runtime,
		sources:      map[string]VarSourceDef{},
		groups:       map[string]VarGroupDef{},
		documents:    map[string]DocumentSchema{},
		rules:        map[string]VarKeyRule{},
		store:        newVarStore(),
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		varFactories: map[string]VarSourceProviderFactory{},
		providers:    map[string]VarSourceProvider{},

		watchers:           map[int]*varWatcher{},
		epochs:             map[string]uint64{},
		status:             map[string]*varScopeStatus{},
		inflight:           map[string]bool{},
		warnedPollInterval: map[string]bool{},
		ctx:                ctx,
		cancel:             cancel,
	}
	for name, def := range projection.VarSources {
		variables.sources[name] = def
	}
	for group, def := range projection.Vars {
		variables.groups[group] = def
	}
	for id, schema := range projection.Documents {
		variables.documents[id] = schema
	}
	for key, rule := range projection.Schema {
		if strings.HasPrefix(key, "var.") {
			variables.rules[key] = rule
		}
	}
	runtime.vars = variables

	runtime.runtimeNamespaces["var"] = struct{}{}
	runtime.runtimeProviders["var"] = func(path string) any {
		value, _, _ := variables.read(toLogicalKey("var", path))
		return value
	}
}

// read resolves a var key via overlay precedence:
//
//	① active runtime snapshot → ② static value.<group>.<rest> → ③ schema default → nil.
//
// Sync and never blocks on the network. For ondemand groups with no snapshot it
// triggers exactly one background fetch and serves the fallback tier meanwhile.
func (variables *varRuntime) read(fullKey string) (any, bool, error) {
	if record, ok := variables.store.get(fullKey); ok {
		return record.base.Value, true, nil
	}

	group := groupFromVarKey(fullKey)
	if def, ok := variables.groups[group]; ok && def.Mode == "ondemand" {
		variables.triggerOndemand(group)
	}

	rest := strings.TrimPrefix(fullKey, "var.")
	if value, ok, err := variables.runtime.readInternal("value."+rest, map[string]bool{}); err != nil {
		return nil, false, err
	} else if ok {
		return value, true, nil
	}

	if rule, ok := variables.rules[fullKey]; ok && rule.HasDefault {
		return rule.Default, true, nil
	}
	return nil, false, nil
}

// resolveNoTrigger resolves a var key through the same overlay precedence as read, but never
// triggers an ondemand background fetch. Used by the required-key gates (startup, refresh),
// where the caller has just fetched and only wants to know whether ANY tier can satisfy the key.
func (variables *varRuntime) resolveNoTrigger(fullKey string) (any, bool, error) {
	if record, ok := variables.store.get(fullKey); ok {
		return record.base.Value, true, nil
	}

	rest := strings.TrimPrefix(fullKey, "var.")
	if value, ok, err := variables.runtime.readInternal("value."+rest, map[string]bool{}); err != nil {
		return nil, false, err
	} else if ok {
		return value, true, nil
	}

	if rule, ok := variables.rules[fullKey]; ok && rule.HasDefault {
		return rule.Default, true, nil
	}
	return nil, false, nil
}

// snapshot returns the current snapshot for a key with freshness computed, or a
// synthesized static/default snapshot when no runtime revision is active.
func (variables *varRuntime) snapshot(fullKey string) (Snapshot, bool) {
	now := time.Now()
	if record, ok := variables.store.get(fullKey); ok {
		return record.snapshot(now), true
	}
	rest := strings.TrimPrefix(fullKey, "var.")
	if value, ok, _ := variables.runtime.readInternal("value."+rest, map[string]bool{}); ok {
		return Snapshot{Key: fullKey, Value: value, Source: VarSourceStatic, Freshness: FreshnessFresh, ObservedAt: now}, true
	}
	if rule, ok := variables.rules[fullKey]; ok && rule.HasDefault {
		return Snapshot{Key: fullKey, Value: rule.Default, Source: VarSourceDefault, Freshness: FreshnessFresh, ObservedAt: now}, true
	}
	return Snapshot{Key: fullKey, Source: VarSourceDefault, Freshness: FreshnessFresh, ObservedAt: now}, false
}

// varBatch is a validated-or-not set of values for one scope (group) sharing a
// generation/revision. Values are keyed by the prefix-stripped key
// (e.g. "agentic.lanes.vinci").
type varBatch struct {
	// scope is the wire scope this revision was authored for (a group, or a dotted key). A
	// commit REPLACES the scope, so it — not the group — decides what the revision displaces.
	// Empty means "the group".
	scope       string
	group       string
	generation  int64
	revision    string
	schemaId    string
	effectiveAt string
	values      map[string]any
}

// ingest is the single commit path for every origin (poll, refresh, receiver
// push). It validates the whole batch first; an invalid batch is rejected
// wholesale and last-known-good is retained. Valid batches commit atomically and
// then notify watchers.
func (variables *varRuntime) ingest(batch varBatch, origin string) error {
	_, err := variables.ingestGated(batch, origin, nil)
	return err
}

// ingestGated is ingest with the optional mixed pull/push ordering gate. When expect is
// non-nil the commit is applied ONLY if the scope's operation epoch still matches — i.e. no
// authoritative event landed while the pull that produced this batch was in flight. Returns
// whether the batch was applied.
//
// CANONICAL RULE (both SDKs): a PUSH always applies (last-write-wins among pushes); a PULL
// applies only when nothing authoritative superseded it. Without the gate a slow pull could
// reintroduce a head the authority had already deactivated, and an ondemand source with no
// poller would stay wrong indefinitely.
func (variables *varRuntime) ingestGated(batch varBatch, origin string, expect *uint64) (bool, error) {
	def := variables.groups[batch.group]
	ttl := parseVarDuration(def.TTL)
	lease := parseVarDuration(def.Lease)
	// Presence of the manifest duration STRING, not the parsed value: `lease: 0s` is a
	// declared zero (expire immediately), an omitted lease is absent (never expires).
	leaseSet := def.Lease != ""
	now := time.Now()

	scope := batch.scope
	if scope == "" {
		scope = batch.group
	}

	// Validation happens before any lock: an invalid revision never reaches the store.
	for rel, value := range batch.values {
		fullKey := "var." + rel
		if err := variables.validateVarValue(fullKey, value); err != nil {
			variables.recordRejection(batch.group, batch.revision, err.Error())
			fmt.Fprintf(os.Stderr, "cnos [warn]: rejected var revision %s for group %q (%s): %v\n", shortRevision(batch.revision), batch.group, origin, err)
			return false, fmt.Errorf("cnos: reject var revision %s for group %q: %w", shortRevision(batch.revision), batch.group, err)
		}
	}

	variables.applyMu.Lock()

	if expect != nil && *expect != variables.epochs[scope] {
		variables.applyMu.Unlock()
		return false, nil
	}

	// Affected keys are the UNION of what the scope served and what this revision carries: a
	// key present in the previous revision and absent from this one loses its runtime head and
	// must fall back through the overlay, waking its watchers just like a changed value does.
	affected := map[string]struct{}{}
	for rel := range batch.values {
		affected["var."+rel] = struct{}{}
	}
	for _, key := range variables.store.scopeKeys(scope) {
		affected[key] = struct{}{}
	}

	prev := make(map[string]Snapshot, len(affected))
	prevFound := make(map[string]bool, len(affected))
	for key := range affected {
		snap, ok := variables.snapshot(key)
		prev[key] = snap
		prevFound[key] = ok
	}

	updates := make(map[string]*varRecord, len(batch.values))
	for rel, value := range batch.values {
		fullKey := "var." + rel
		var lastKnownGood *LastKnownGood
		if priorRecord, ok := variables.store.get(fullKey); ok && priorRecord.base.Source == VarSourceRuntime {
			lastKnownGood = &LastKnownGood{Generation: priorRecord.base.Generation, Revision: priorRecord.base.Revision}
		}
		updates[fullKey] = &varRecord{
			base: Snapshot{
				Key:           fullKey,
				Value:         value,
				Generation:    batch.generation,
				Revision:      batch.revision,
				SchemaId:      batch.schemaId,
				EffectiveAt:   batch.effectiveAt,
				ObservedAt:    now,
				Source:        VarSourceRuntime,
				LastKnownGood: lastKnownGood,
			},
			ttl:      ttl,
			lease:    lease,
			leaseSet: leaseSet,
		}
	}

	variables.store.commit(scope, batch.group, updates)
	variables.epochs[scope]++
	variables.recordSuccess(batch.group, batch.generation, batch.revision, now)

	event := variables.buildNotifyEvent(affected, prev, prevFound)
	variables.enqueueNotification(event)
	variables.applyMu.Unlock()

	variables.drainNotifications()
	return true, nil
}

// buildNotifyEvent freezes one commit's watcher deliveries. Must be called under applyMu,
// AFTER the store mutation, so `next` reflects exactly the state this commit produced.
func (variables *varRuntime) buildNotifyEvent(affected map[string]struct{}, prev map[string]Snapshot, prevFound map[string]bool) varNotifyEvent {
	variables.mu.Lock()
	ids := make([]int, 0, len(variables.watchers))
	for id := range variables.watchers {
		ids = append(ids, id)
	}
	variables.mu.Unlock()

	entries := make([]varNotifyEntry, 0, len(affected))
	for key := range affected {
		// The EFFECTIVE snapshot, not just the runtime tier: after a removal the key still
		// resolves — from static/default — and that is what the watcher must be handed.
		next, _ := variables.snapshot(key)
		previous := prev[key]

		// Revision is content-addressed, so an equal revision means equal content and there is
		// nothing to react to. Generation is deliberately excluded: a push without an explicit
		// revision is stamped with a wall-clock generation, so gating on it would wake every
		// watcher on each replay of an identical document. `source` participates because
		// static/default snapshots carry no revision at all: runtime→static is a real change
		// even though both sides compare equal on `revision`. Identical to the Node gate.
		if prevFound[key] && previous.Revision == next.Revision && previous.Source == next.Source {
			continue
		}

		entries = append(entries, varNotifyEntry{key: key, next: next, prev: previous, hasPrev: prevFound[key]})
	}

	return varNotifyEvent{watcherIDs: ids, entries: entries}
}

// enqueueNotification appends a committed event. Must be called under applyMu so the queue
// order is the commit order.
func (variables *varRuntime) enqueueNotification(event varNotifyEvent) {
	if len(event.entries) == 0 {
		return
	}
	variables.notifyMu.Lock()
	variables.notifyQueue = append(variables.notifyQueue, event)
	variables.notifyMu.Unlock()
}

// drainNotifications delivers queued events strictly in commit order, finishing one event for
// EVERY watcher before starting the next.
//
// It is both reentrancy- and concurrency-safe: a callback that commits again (a reactivation
// from inside a deactivation handler) enqueues its event and returns here immediately, and the
// loop below picks it up once the current event is fully delivered. A second goroutine
// committing concurrently likewise hands its event to the goroutine already dispatching
// instead of interleaving with it — which is how an older activation could be delivered after
// a newer deactivation.
func (variables *varRuntime) drainNotifications() {
	variables.notifyMu.Lock()
	if variables.dispatching {
		variables.notifyMu.Unlock()
		return
	}
	variables.dispatching = true

	for {
		if len(variables.notifyQueue) == 0 {
			variables.dispatching = false
			variables.notifyMu.Unlock()
			return
		}
		event := variables.notifyQueue[0]
		variables.notifyQueue = variables.notifyQueue[1:]
		variables.notifyMu.Unlock()

		variables.dispatch(event)

		variables.notifyMu.Lock()
	}
}

// dispatch delivers one frozen event. The registry was snapshotted at commit time (so a
// watcher registered from inside a callback is not visited by an event committed before it
// existed) and each entry is re-checked against the live registry (so unsubscribing from
// inside a callback suppresses a not-yet-delivered fire). Both match the Node SDK.
func (variables *varRuntime) dispatch(event varNotifyEvent) {
	for _, entry := range event.entries {
		for _, id := range event.watcherIDs {
			variables.mu.Lock()
			watcher, live := variables.watchers[id]
			variables.mu.Unlock()

			if live && watcher.match(entry.key) {
				invokeWatcher(watcher.fn, entry.next, entry.prev)
			}
		}
	}
}

// applyNoHead clears the runtime tier for a scope after the authority definitively reported it
// has NO active head (http 404 {code:"no-head"}, rpc no_head). Reads then fall through the
// overlay to ② static value.<group>.<rest> and ③ the schema default with no redeploy
// (acceptance #15). Watchers fire because the EFFECTIVE value changed — they receive the new
// static/default snapshot.
//
// A transport error is NOT a no-head and never lands here: an unreachable remote retains
// last-known-good, which is what the lease/freshness model exists to describe. Idempotent: a
// no-head for a scope with nothing applied wakes nobody. Mirrors the Node
// VarManager.applyNoHead / LiveVarStore.removeScope.
func (variables *varRuntime) applyNoHead(scope string) {
	variables.applyNoHeadGated(scope, nil)
}

// applyNoHeadGated is applyNoHead with the mixed pull/push ordering gate (see ingestGated).
// A pulled no-head is dropped when an authoritative event landed for the scope while the pull
// was in flight — otherwise a delayed 404 could clear a newer pushed activation.
func (variables *varRuntime) applyNoHeadGated(scope string, expect *uint64) bool {
	now := time.Now()
	group := groupFromVarKey("var." + scope)

	variables.applyMu.Lock()

	if expect != nil && *expect != variables.epochs[scope] {
		variables.applyMu.Unlock()
		return false
	}

	// A no-head is an authoritative answer even when it removes nothing, so it always
	// supersedes an in-flight pull.
	variables.epochs[scope]++

	affected := map[string]struct{}{}
	prev := map[string]Snapshot{}
	prevFound := map[string]bool{}
	for _, key := range variables.store.keys() {
		if key == "var."+scope || strings.HasPrefix(key, "var."+scope+".") {
			affected[key] = struct{}{}
			snap, ok := variables.snapshot(key)
			prev[key] = snap
			prevFound[key] = ok
		}
	}

	removed := variables.store.removeScope(scope)

	// Refresh metadata is updated for EVERY valid no-head, removal or not. Returning early on
	// an empty store left Go reporting a stale transport error after the authority had
	// definitively answered, while Node reported recovery. Only the watcher notification and
	// the deactivation warning depend on whether records were actually removed.
	variables.mu.Lock()
	status := variables.statusFor(group)
	status.lastRefreshAt = now
	status.lastError = ""
	if len(removed) > 0 {
		// The removed head must not masquerade as still applied in VarStatus().
		status.desiredGeneration = nil
		status.revision = ""
	}
	variables.mu.Unlock()

	if len(removed) == 0 {
		variables.applyMu.Unlock()
		return true
	}

	event := variables.buildNotifyEvent(affected, prev, prevFound)
	variables.enqueueNotification(event)
	variables.applyMu.Unlock()

	fmt.Fprintf(os.Stderr, "cnos [warn]: var scope %q has no active runtime head (deactivated); cleared the runtime tier and restored the static/default tiers\n", scope)

	variables.drainNotifications()
	return true
}

func invokeWatcher(fn func(next, prev Snapshot), next, prev Snapshot) {
	defer func() { _ = recover() }()
	fn(next, prev)
}

// watch registers a callback fired after each validated, committed update to a
// matching key. keyOrPrefix accepts "var.user.*" (prefix) or an exact key.
func (variables *varRuntime) watch(keyOrPrefix string, fn func(next, prev Snapshot)) func() {
	matcher := compileWatchMatcher(keyOrPrefix)
	variables.mu.Lock()
	id := variables.nextWatch
	variables.nextWatch++
	variables.watchers[id] = &varWatcher{match: matcher, fn: fn}
	variables.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			variables.mu.Lock()
			delete(variables.watchers, id)
			variables.mu.Unlock()
		})
	}
}

func compileWatchMatcher(spec string) func(string) bool {
	normalized := spec
	if !strings.HasPrefix(normalized, "var.") {
		normalized = "var." + normalized
	}
	if strings.HasSuffix(normalized, "*") {
		prefix := strings.TrimSuffix(normalized, "*")
		return func(key string) bool { return strings.HasPrefix(key, prefix) }
	}
	return func(key string) bool { return key == normalized }
}

// refreshVar fetches the key's group if the current snapshot is not fresh
// (honoring ttl). A required key that cannot be fetched returns ErrVarRequired.
func (variables *varRuntime) refreshVar(ctx context.Context, fullKey string) error {
	group := groupFromVarKey(fullKey)
	if _, ok := variables.groups[group]; !ok {
		return nil
	}
	if record, ok := variables.store.get(fullKey); ok {
		if record.snapshot(time.Now()).Freshness == FreshnessFresh {
			return nil
		}
	}
	// A transport failure OR a validation-rejected revision on a required key is ErrVarRequired:
	// the remote failed to produce a usable answer. A no-head is NOT such a failure — it is a
	// definitive answer ("use the fallback tiers"), so refresh succeeds and the key stays
	// fail-fast LAZILY at read/Require time. The Node SDK mirrors both halves of this rule.
	if err := variables.fetchGroup(ctx, group); err != nil {
		if rule, ok := variables.rules[fullKey]; ok && rule.Required {
			// Two `%w` verbs preserve the transport error in the unwrap chain (previously `%v`
			// stringified it away), so errors.Is/As can reach the underlying cause.
			return fmt.Errorf("%w: %s: %w", ErrVarRequired, fullKey, err)
		}
		return err
	}
	return nil
}

// refreshVars is an EXPLICIT caller request, so it attempts EVERY configured group with a source
// — prefetch AND ondemand alike (prefetch/ondemand governs the automatic lifecycle, not the scope
// of an explicit refresh). It never short-circuits: every group is attempted to completion, and if
// any failed an AGGREGATE error is returned (required-group failures preferred over optional ones,
// each wrapping its transport cause); nil only when every group succeeded. A `not-modified` and a
// `no-head` are SUCCESSFUL outcomes (a `no-head` applies the normal deactivation path), never
// failures. Background pollers remain best-effort; this contract is for the explicit API only.
// Mirrors the Node SDK's refreshVars() failure contract.
func (variables *varRuntime) refreshVars(ctx context.Context) error {
	var requiredErr error
	var optionalErr error
	for group := range variables.groups {
		if err := variables.fetchGroup(ctx, group); err != nil {
			if variables.groupHasRequired(group) {
				requiredErr = joinErrors(requiredErr, fmt.Errorf("%w: group %q: %w", ErrVarRequired, group, err))
			} else {
				optionalErr = joinErrors(optionalErr, err)
			}
		}
	}
	if requiredErr != nil {
		return requiredErr
	}
	return optionalErr
}

// fetchGroup pulls the group's scope and ingests a fresh revision. A no-head (404) CLEARS any
// applied runtime head for the scope so overlay tiers ②/③ serve again; a transport error leaves
// last-known-good untouched.
func (variables *varRuntime) fetchGroup(ctx context.Context, group string) error {
	def, ok := variables.groups[group]
	if !ok {
		return fmt.Errorf("cnos: unknown var group %q", group)
	}
	source, ok := variables.sources[def.Source]
	if !ok {
		return fmt.Errorf("cnos: var group %q references unknown source %q", group, def.Source)
	}
	// Capture the scope's operation epoch BEFORE the network call: the result is applied only
	// if nothing authoritative (a pushed batch, a pushed deactivation) landed meanwhile.
	epoch := variables.scopeEpoch(group)

	result, err := variables.pullScope(ctx, def.Source, source, group, variables.knownRevision(group))
	if err != nil {
		variables.recordError(group, err.Error())
		return err
	}
	switch result.status {
	case pullOK:
		_, ingestErr := variables.ingestGated(varBatch{
			scope:       group,
			group:       group,
			generation:  result.generation,
			revision:    result.revision,
			schemaId:    result.schemaId,
			effectiveAt: result.effectiveAt,
			values:      result.values,
		}, "poll", &epoch)
		return ingestErr
	case pullNotModified:
		// The known revision is still current — the cached snapshot already IS the head.
		return nil
	case pullNoHead:
		// A definitive "no active head": clear the runtime tier so overlay tiers ②/③ serve.
		variables.applyNoHeadGated(group, &epoch)
		return nil
	}
	return nil
}

// scopeEpoch reads the scope's current operation epoch (see ingestGated).
func (variables *varRuntime) scopeEpoch(scope string) uint64 {
	variables.applyMu.Lock()
	defer variables.applyMu.Unlock()
	return variables.epochs[scope]
}

// triggerOndemand starts at most one background fetch per group (dedup).
func (variables *varRuntime) triggerOndemand(group string) {
	variables.mu.Lock()
	if variables.closed || variables.inflight[group] {
		variables.mu.Unlock()
		return
	}
	variables.inflight[group] = true
	variables.mu.Unlock()

	go func() {
		defer func() {
			variables.mu.Lock()
			delete(variables.inflight, group)
			variables.mu.Unlock()
		}()
		_ = variables.fetchGroup(variables.ctx, group)
	}()
}

// start runs prefetch resolution and launches pollers/subscriptions, exactly once.
//
// Concurrent callers SHARE the in-flight attempt (mirroring the Node SDK, which memoizes the
// start promise) instead of the second caller seeing a "started" flag and returning nil before
// prefetch has finished — which reported a ready runtime that might then fail for caller #1.
// The stored attempt is cleared on failure so a retry is possible, and kept on success so
// repeat calls are cheap no-ops.
func (variables *varRuntime) start(ctx context.Context) error {
	variables.mu.Lock()
	if variables.closed {
		variables.mu.Unlock()
		// A closed runtime can never become ready; reporting success would leave the caller
		// running on fallback tiers with no pollers and no subscriptions. Mirrors the Node SDK.
		return ErrVarClosed
	}
	if attempt := variables.startAttempt; attempt != nil {
		variables.mu.Unlock()
		select {
		case <-attempt.done:
			return attempt.err
		case <-ctx.Done():
			// The CALLER gave up waiting. The attempt itself keeps running for whoever started it.
			return ctx.Err()
		}
	}
	attempt := &varStartAttempt{done: make(chan struct{})}
	variables.startAttempt = attempt
	variables.mu.Unlock()

	err := variables.runStart(ctx)
	if err != nil {
		// Clear the latch BEFORE releasing the waiters so a retry is possible. Without this a
		// transient transport failure would leave the runtime marked started forever: the next
		// StartVars would return nil and the process would run on with no pollers or
		// subscriptions — reporting success while silently serving only fallback tiers.
		variables.mu.Lock()
		if variables.startAttempt == attempt {
			variables.startAttempt = nil
		}
		variables.mu.Unlock()
	}
	attempt.err = err
	close(attempt.done)

	return err
}

// runStart performs one startup attempt: prefetch groups fetch in parallel, a required key left
// unresolved fails Ready, optional failures warn, then pollers and subscriptions start.
//
// Prefetch pulls run on the CALLER's ctx, so a caller deadline/cancellation actually bounds
// startup (an http pull would otherwise block until the client's 30s timeout). Long-lived
// pollers and subscriptions deliberately keep variables.ctx: they must outlive the caller's ctx,
// which is routinely cancelled the moment Ready() returns.
func (variables *varRuntime) runStart(ctx context.Context) error {
	prefetch := make([]string, 0)
	for group, def := range variables.groups {
		if def.Mode == "prefetch" {
			prefetch = append(prefetch, group)
		}
	}

	// Prefetch runs on a ctx derived from BOTH the caller's ctx and the runtime's, so close()
	// actually cancels an in-flight startup instead of waiting out a 30s http timeout while the
	// attempt goes on to create providers, pollers and subscriptions behind its back.
	fetchCtx, cancelFetch := context.WithCancel(ctx)
	defer cancelFetch()
	go func() {
		select {
		case <-variables.ctx.Done():
			cancelFetch()
		case <-fetchCtx.Done():
		}
	}()

	// Capture each group's prefetch error so the required-key gate below can preserve the
	// underlying transport/authentication failure as the CAUSE of ErrVarRequired — the caller
	// then gets both the configuration meaning (this key is required and unresolved) and the
	// actionable underlying failure. Mirrors the Node SDK's `new CnosVarRequiredError(key, { cause })`.
	var wg sync.WaitGroup
	var fetchMu sync.Mutex
	fetchErrs := map[string]error{}
	for _, group := range prefetch {
		wg.Add(1)
		go func(g string) {
			defer wg.Done()
			if err := variables.fetchGroup(fetchCtx, g); err != nil {
				fetchMu.Lock()
				fetchErrs[g] = err
				fetchMu.Unlock()
			}
		}(group)
	}
	wg.Wait()

	// Re-check after every wait and BEFORE creating any long-lived resource: close() may have
	// run while prefetch was in flight, and anything created now would never be released.
	if variables.isClosed() {
		return ErrVarClosed
	}

	// A cancelled/expired caller ctx means startup did not actually complete — fail rather than
	// launching pollers behind a half-resolved prefetch.
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("cnos: var startup cancelled: %w", err)
	}

	// Only PREFETCH groups gate Ready. A required key in an ondemand group is still fail-fast,
	// but lazily: refreshVar returns ErrVarRequired and read/Require report it unresolved at
	// call time. Blocking startup on an ondemand key would defeat the point of ondemand and
	// diverges from the Node SDK, which only resolves prefetch groups during ready().
	for fullKey, rule := range variables.rules {
		if !rule.Required {
			continue
		}
		if def, ok := variables.groups[groupFromVarKey(fullKey)]; !ok || def.Mode != "prefetch" {
			continue
		}
		if _, ok, err := variables.resolveNoTrigger(fullKey); err != nil {
			return err
		} else if !ok {
			// Two `%w` verbs (Go 1.20+) wrap BOTH the required sentinel and the transport cause, so
			// errors.Is(err, ErrVarRequired) AND errors.Is/As against the transport error both work.
			if cause := fetchErrs[groupFromVarKey(fullKey)]; cause != nil {
				return fmt.Errorf("%w: %s: %w", ErrVarRequired, fullKey, cause)
			}
			return fmt.Errorf("%w: %s", ErrVarRequired, fullKey)
		}
	}

	for _, group := range prefetch {
		if !variables.groupHasRequired(group) {
			if msg := variables.lastError(group); msg != "" {
				fmt.Fprintf(os.Stderr, "cnos [warn]: var group %q prefetch degraded, serving fallback: %s\n", group, msg)
			}
		}
	}

	if variables.isClosed() {
		return ErrVarClosed
	}

	variables.startPollers()
	variables.startSubscriptions()

	if variables.isClosed() {
		return ErrVarClosed
	}
	return nil
}

// isClosed reports whether close() has run. Checked after every wait in the startup path.
func (variables *varRuntime) isClosed() bool {
	variables.mu.Lock()
	defer variables.mu.Unlock()
	return variables.closed
}

// startPollers spawns one poll loop per prefetch group on a PULL-ONLY source that declares a
// pollInterval. Groups back off independently, so a failing scope never throttles a healthy one.
//
// CANONICAL RULE (identical in the Node SDK): polling is keyed off the provider's declared
// CAPABILITIES, never the transport name — poll only when the provider does NOT implement
// Subscribe. A subscribe-capable provider (rpc) relies on its stream; polling behind it would
// double-fetch and, worse, silently paper over a TERMINAL subscription, which is the exact
// failure the terminal state exists to advertise. A pollInterval on a subscribe-capable source
// is ignored — warned once so the config is not silently dropped.
func (variables *varRuntime) startPollers() {
	if variables.isClosed() {
		return
	}

	for group, def := range variables.groups {
		if def.Mode != "prefetch" {
			continue
		}
		source, ok := variables.sources[def.Source]
		if !ok || parseVarDuration(source.PollInterval) <= 0 {
			continue
		}
		if variables.sourceCanSubscribe(def.Source, source) {
			continue
		}
		interval := parseVarDuration(source.PollInterval)
		go variables.pollLoop(group, interval)
	}
}

func (variables *varRuntime) pollLoop(group string, interval time.Duration) {
	attempt := 0
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-variables.ctx.Done():
			return
		case <-timer.C:
			if err := variables.fetchGroup(variables.ctx, group); err != nil {
				attempt++
				timer.Reset(nextBackoff(attempt))
			} else {
				attempt = 0
				timer.Reset(interval)
			}
		}
	}
}

// nextBackoff returns a capped exponential backoff with jitter.
func nextBackoff(attempt int) time.Duration {
	const base = time.Second
	const ceiling = time.Minute
	next := base
	for i := 0; i < attempt && next < ceiling; i++ {
		next *= 2
	}
	if next > ceiling {
		next = ceiling
	}
	floor := next / 2
	return floor + time.Duration(rand.Int63n(int64(next-floor)+1))
}

// close stops all pollers/goroutines and releases watchers. Idempotent.
func (variables *varRuntime) close() error {
	variables.mu.Lock()
	if variables.closed {
		variables.mu.Unlock()
		return nil
	}
	variables.closed = true
	cancel := variables.cancel
	attempt := variables.startAttempt
	variables.mu.Unlock()

	// Cancel FIRST so an in-flight prefetch aborts instead of running to its transport timeout,
	// then WAIT for the startup attempt to stop. Only once it has can the sets below be
	// complete: a start() that finished prefetch after close() had already walked them created
	// providers, pollers and subscriptions that nothing ever released.
	if cancel != nil {
		cancel()
	}
	if attempt != nil {
		<-attempt.done
	}

	variables.mu.Lock()
	variables.watchers = map[int]*varWatcher{}
	subscriptions := variables.subscriptions
	variables.subscriptions = nil
	providers := make([]VarSourceProvider, 0, len(variables.providers))
	for _, provider := range variables.providers {
		providers = append(providers, provider)
	}
	variables.providers = map[string]VarSourceProvider{}
	variables.mu.Unlock()

	for _, stop := range subscriptions {
		if stop != nil {
			stop()
		}
	}
	for _, provider := range providers {
		_ = provider.Close()
	}

	if cancel != nil {
		cancel()
	}
	if variables.httpClient != nil {
		variables.httpClient.CloseIdleConnections()
	}
	return nil
}

func (variables *varRuntime) knownRevision(group string) string {
	variables.mu.Lock()
	defer variables.mu.Unlock()
	if status, ok := variables.status[group]; ok {
		return status.revision
	}
	return ""
}

func (variables *varRuntime) lastError(group string) string {
	variables.mu.Lock()
	defer variables.mu.Unlock()
	if status, ok := variables.status[group]; ok {
		return status.lastError
	}
	return ""
}

func (variables *varRuntime) groupHasRequired(group string) bool {
	for key, rule := range variables.rules {
		if rule.Required && groupFromVarKey(key) == group {
			return true
		}
	}
	return false
}

func (variables *varRuntime) statusFor(group string) *varScopeStatus {
	status, ok := variables.status[group]
	if !ok {
		status = &varScopeStatus{}
		variables.status[group] = status
	}
	return status
}

func (variables *varRuntime) recordSuccess(group string, generation int64, revision string, now time.Time) {
	variables.mu.Lock()
	defer variables.mu.Unlock()
	status := variables.statusFor(group)
	status.revision = revision
	status.lastRefreshAt = now
	status.lastError = ""
	desired := generation
	status.desiredGeneration = &desired
}

func (variables *varRuntime) recordRejection(group, revision, reason string) {
	variables.mu.Lock()
	defer variables.mu.Unlock()
	status := variables.statusFor(group)
	status.lastRejected = &VarRejection{Revision: revision, Reason: reason, At: time.Now().UTC().Format(time.RFC3339)}
	status.lastError = reason
}

// recordSubscription stores the transport-reported state of a group's push
// subscription for VarStatus(). A background stream failure is never returned to the
// caller and never panics the host process — it surfaces here.
func (variables *varRuntime) recordSubscription(group, state, message string, attempts int) {
	variables.mu.Lock()
	defer variables.mu.Unlock()
	status := variables.statusFor(group)
	status.subscription = &VarSubscriptionStatus{
		State:     state,
		LastError: message,
		Attempts:  attempts,
		At:        time.Now().UTC().Format(time.RFC3339),
	}
	if message != "" {
		status.lastError = message
	}
}

func (variables *varRuntime) recordError(group, message string) {
	variables.mu.Lock()
	defer variables.mu.Unlock()
	variables.statusFor(group).lastError = message
}

// statusDoc builds the per-key observability document. Keyed by prefix-stripped
// key. Contains no var values or secret material.
func (variables *varRuntime) statusDoc() map[string]VarStatusEntry {
	now := time.Now()
	keys := map[string]struct{}{}
	for key := range variables.rules {
		keys[key] = struct{}{}
	}
	for _, key := range variables.store.keys() {
		keys[key] = struct{}{}
	}

	variables.mu.Lock()
	statusCopy := map[string]varScopeStatus{}
	for group, status := range variables.status {
		statusCopy[group] = *status
	}
	variables.mu.Unlock()

	result := map[string]VarStatusEntry{}
	for fullKey := range keys {
		group := groupFromVarKey(fullKey)
		// `none`/`none` until a tier claims the key: a key that resolves from NO tier must not be
		// reported as served by (or as fresh as) the `default` tier it has no default in. Matches
		// the Node SDK's `source: 'none', freshness: 'none'` and the ADR's definition of the field.
		entry := VarStatusEntry{Source: VarSourceNone, Freshness: FreshnessNone}
		if snap, ok := variables.snapshot(fullKey); ok {
			entry.Source = snap.Source
			entry.Freshness = snap.Freshness
			entry.Revision = snap.Revision
			entry.AppliedGeneration = snap.Generation
			if snap.Source == VarSourceRuntime {
				entry.SnapshotAge = now.Sub(snap.ObservedAt).Seconds()
			}
		}
		if status, ok := statusCopy[group]; ok {
			entry.DesiredGeneration = status.desiredGeneration
			if !status.lastRefreshAt.IsZero() {
				entry.LastRefreshAt = status.lastRefreshAt.UTC().Format(time.RFC3339)
			}
			entry.LastError = status.lastError
			entry.LastRejected = status.lastRejected
			entry.Subscription = status.subscription
		}
		result[strings.TrimPrefix(fullKey, "var.")] = entry
	}
	return result
}

func shortRevision(revision string) string {
	if len(revision) > 19 {
		return revision[:19] + "…"
	}
	if revision == "" {
		return "(none)"
	}
	return revision
}

// --- Runtime var API (mirrors Secret/RefreshSecret naming) ---

// Var reads a var path via overlay precedence (runtime → value.* → default).
func (runtime *Runtime) Var(path string) (any, bool, error) {
	return runtime.Read(toLogicalKey("var", path))
}

// VarSnapshot returns the in-memory snapshot (value + metadata) for a var key.
func (runtime *Runtime) VarSnapshot(key string) (Snapshot, bool) {
	if runtime.vars == nil {
		return Snapshot{}, false
	}
	return runtime.vars.snapshot(toLogicalKey("var", key))
}

// RefreshVar fetches the key's group if the snapshot is not fresh (honors ttl).
func (runtime *Runtime) RefreshVar(ctx context.Context, key string) error {
	if runtime.vars == nil {
		return nil
	}
	return runtime.vars.refreshVar(ctx, toLogicalKey("var", key))
}

// RefreshVars refreshes every var group with a source.
func (runtime *Runtime) RefreshVars(ctx context.Context) error {
	if runtime.vars == nil {
		return nil
	}
	return runtime.vars.refreshVars(ctx)
}

// Watch registers a callback fired after each validated, committed var update.
// keyOrPrefix accepts an exact key or a "var.user.*" prefix. The returned func
// unregisters the watcher.
func (runtime *Runtime) Watch(keyOrPrefix string, fn func(next, prev Snapshot)) func() {
	if runtime.vars == nil {
		return func() {}
	}
	return runtime.vars.watch(keyOrPrefix, fn)
}

// VarStatus returns the per-scope observability document.
func (runtime *Runtime) VarStatus() map[string]VarStatusEntry {
	if runtime.vars == nil {
		return map[string]VarStatusEntry{}
	}
	return runtime.vars.statusDoc()
}

// VarReceiver returns an http.Handler that latches inbound pushes for a source
// onto the host's existing mux (e.g. mux.Handle("/cnos/vars/", h)). It never
// starts its own server.
func (runtime *Runtime) VarReceiver(source string, options ...VarReceiverOption) http.Handler {
	if runtime.vars == nil {
		return http.NotFoundHandler()
	}
	return runtime.vars.receiver(source, options...)
}

// StartVars runs prefetch resolution and launches pollers. Called by Ready();
// exposed for runtimes not driven through the singleton.
func (runtime *Runtime) StartVars(ctx context.Context) error {
	if runtime.vars == nil {
		return nil
	}
	return runtime.vars.start(ctx)
}

// Close stops var pollers/goroutines and releases watchers. Idempotent.
func (runtime *Runtime) Close() error {
	if runtime.vars == nil {
		return nil
	}
	return runtime.vars.close()
}
