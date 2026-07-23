package cnos

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// Var pull outcomes. These mirror the http status mapping exactly and are the values a
// transport provider reports back to the SDK:
//
//	VarPullOK          — a fresh head batch (http 200)
//	VarPullNotModified — the caller's known revision is still current (http 304), keep cache
//	VarPullNoHead      — no active runtime head (http 404 {code:"no-head"}), fall back to
//	                     overlay tiers ②/③ (static value.* / schema default)
const (
	VarPullOK          = pullOK
	VarPullNotModified = pullNotModified
	VarPullNoHead      = pullNoHead
)

// VarScope identifies a fetch scope: exactly one of Key or Group. Scope kind is
// syntactically decidable from the prefix-stripped string — a group is a single segment
// with no dot, a key always contains a dot.
type VarScope struct {
	Key   string
	Group string
}

// Scope returns the wire scope string (the `var.` prefix is already stripped).
func (scope VarScope) Scope() string {
	if scope.Key != "" {
		return scope.Key
	}
	return scope.Group
}

// VarBatchResult is the transport-agnostic result of a pull or a pushed subscription
// batch. Values are keyed by the full var key minus the `var.` prefix, per the canonical
// cross-SDK keying convention.
type VarBatchResult struct {
	Status      int
	Scope       string
	Generation  int64
	Revision    string
	SchemaId    string
	EffectiveAt string
	Values      map[string]any
}

// VarProviderContext hands a provider the runtime facilities it needs. ResolveSecret
// resolves a `secret.*` reference to material through the normal CNOS secret machinery —
// providers never read secret material any other way.
type VarProviderContext struct {
	ResolveSecret func(ref string) (string, error)
	// OnSubscriptionError reports a background subscription failure so it can surface in
	// VarStatus(). A provider must never panic out of a stream goroutine or fail silently;
	// it reports here instead. terminal == true means the provider has given up
	// reconnecting for those scopes.
	OnSubscriptionError func(err error, terminal bool, scopes []string)
	// OnSubscriptionConnected reports that a subscription stream for these scopes is
	// established. The SDK answers by RE-PULLING them with their known revisions so a mutation
	// that happened while the stream was down still converges: the server only ever forwards
	// FUTURE commits, so without this a missed deactivation would serve withdrawn policy
	// forever — and an rpc source runs no poller to recover with.
	//
	// A provider must call it AFTER issuing the Subscribe call, never before: with the
	// subscription opened first, a commit racing the resync pull arrives on the stream instead
	// of being dropped. reconnect is false only for the very first connect of a subscription;
	// the SDK then skips scopes it already prefetched. Mirrors the TypeScript
	// VarSourceProviderContext.onSubscriptionConnected.
	OnSubscriptionConnected func(scopes []string, reconnect bool)
}

// VarSourceProvider is the transport contract, mirroring the TypeScript
// `VarSourceProvider`. Transport modules (rpc, ws, sse) live in their own Go submodules so
// the core module stays free of their dependencies.
type VarSourceProvider interface {
	Pull(ctx context.Context, scope VarScope, knownRevision string) (VarBatchResult, error)
	Close() error
}

// VarSubscribingProvider is additionally implemented by push transports. Subscribe returns
// a stop function; the provider owns reconnect/backoff internally.
type VarSubscribingProvider interface {
	VarSourceProvider
	Subscribe(ctx context.Context, scopes []VarScope, onBatch func(VarBatchResult)) (func(), error)
}

// VarSourceProviderFactory registers a provider implementation by transport name. It is the
// var-side twin of SecretVaultProviderFactory and registers the same way.
type VarSourceProviderFactory struct {
	Transport string
	Create    func(def VarSourceDef, providerCtx VarProviderContext) (VarSourceProvider, error)
}

func varSourceFactoryMap(factories []VarSourceProviderFactory) map[string]VarSourceProviderFactory {
	result := map[string]VarSourceProviderFactory{}
	for _, factory := range factories {
		transport := strings.TrimSpace(factory.Transport)
		if transport == "" || factory.Create == nil {
			continue
		}
		result[transport] = factory
	}
	return result
}

// RegisterVarSourceProviders adds var transport provider factories to this runtime. Safe to
// call after Load: providers are constructed lazily on first use.
func (runtime *Runtime) RegisterVarSourceProviders(factories ...VarSourceProviderFactory) {
	if runtime.vars == nil {
		return
	}
	runtime.vars.mu.Lock()
	defer runtime.vars.mu.Unlock()
	if runtime.vars.varFactories == nil {
		runtime.vars.varFactories = map[string]VarSourceProviderFactory{}
	}
	for transport, factory := range varSourceFactoryMap(factories) {
		runtime.vars.varFactories[transport] = factory
	}
}

// isBuiltinTransport reports whether the built-in stdlib http client serves this transport.
// An empty transport defaults to http for backward compatibility.
func isBuiltinTransport(transport string) bool {
	return transport == "" || transport == "http"
}

// providerFor lazily constructs (and caches) the registered provider for a source.
func (variables *varRuntime) providerFor(sourceName string, source VarSourceDef) (VarSourceProvider, error) {
	variables.mu.Lock()
	if variables.closed {
		variables.mu.Unlock()
		return nil, fmt.Errorf("cnos: cannot construct a var source provider for %q: %w", sourceName, ErrVarClosed)
	}
	if provider, ok := variables.providers[sourceName]; ok {
		variables.mu.Unlock()
		return provider, nil
	}
	factory, ok := variables.varFactories[source.Transport]
	variables.mu.Unlock()

	if !ok {
		return nil, fmt.Errorf(
			"cnos: no var source provider registered for transport %q (source %q). Register one via Options.VarSourceProviders or RegisterVarSourceProviders",
			source.Transport, sourceName,
		)
	}

	provider, err := factory.Create(source, VarProviderContext{
		ResolveSecret:           variables.resolveSecretRef,
		OnSubscriptionError:     variables.reportSubscriptionError(sourceName),
		OnSubscriptionConnected: variables.resyncSubscribedScopes,
	})
	if err != nil {
		return nil, fmt.Errorf("cnos: create var source provider for %q: %w", sourceName, err)
	}

	variables.mu.Lock()
	if variables.closed {
		// close() ran while the factory was constructing. Release ours rather than caching an
		// instance nothing will ever close.
		variables.mu.Unlock()
		_ = provider.Close()
		return nil, fmt.Errorf("cnos: cannot construct a var source provider for %q: %w", sourceName, ErrVarClosed)
	}
	if existing, ok := variables.providers[sourceName]; ok {
		// Lost a construction race — keep the winner and release ours.
		variables.mu.Unlock()
		_ = provider.Close()
		return existing, nil
	}
	variables.providers[sourceName] = provider
	variables.mu.Unlock()
	return provider, nil
}

// reportSubscriptionError builds the OnSubscriptionError callback handed to a provider.
// Failures land in VarStatus() as the scope's subscription state and a stderr warning —
// never as a panic and never silently.
func (variables *varRuntime) reportSubscriptionError(sourceName string) func(error, bool, []string) {
	return func(err error, terminal bool, scopes []string) {
		if err == nil {
			return
		}

		state := VarSubscriptionRetrying
		detail := "dropped (retrying)"
		if terminal {
			state = VarSubscriptionFailed
			detail = "FAILED (terminal, no further reconnects)"
		}

		if len(scopes) == 0 {
			scopes = variables.groupsForSource(sourceName)
		}
		for _, scope := range scopes {
			variables.recordSubscription(groupFromVarKey(scope), state, err.Error(), 0)
		}

		fmt.Fprintf(os.Stderr, "cnos [warn]: var subscription for source %q %s: %v\n", sourceName, detail, err)
	}
}

// resyncSubscribedScopes converges every subscribed scope on a (re)connected stream — the SDK
// half of the ADR's "on reconnect, re-pull subscribed scopes with known revisions to converge".
//
// The server only ever forwards FUTURE commits, so a mutation that landed while the stream was
// down is lost without this: unrecoverable for an rpc source (it runs no poller), and since a
// deactivation is a real state change, a missed one means serving withdrawn policy forever.
// The pull is issued AFTER the subscription is open, so a commit racing it arrives on the
// stream instead of vanishing, and the scope's operation epoch decides which of the two wins.
//
// On the FIRST connect a scope is skipped only when a head was already prefetched for it; when
// in doubt, pull — a redundant pull is far cheaper than a lost deactivation.
func (variables *varRuntime) resyncSubscribedScopes(scopes []string, reconnect bool) {
	if variables.isClosed() {
		return
	}

	for _, scope := range scopes {
		if !reconnect && variables.knownRevision(scope) != "" {
			continue
		}

		// Routed through the NORMAL pull path: ingest, not-modified, and no-head → scope
		// removal all behave exactly as they do for a poller. A failure is not fatal — the
		// stream is live and the next commit converges.
		go func(target string) { _ = variables.fetchGroupExactNoHead(variables.ctx, target) }(scope)
	}
}

// groupsForSource lists the groups served by a var source.
func (variables *varRuntime) groupsForSource(sourceName string) []string {
	result := []string{}
	for group, def := range variables.groups {
		if def.Source == sourceName {
			result = append(result, group)
		}
	}
	return result
}

// resolveSecretRef resolves a `secret.*` ref through the existing Go secrets machinery.
func (variables *varRuntime) resolveSecretRef(ref string) (string, error) {
	value, found, err := variables.runtime.Read(ref)
	if err != nil {
		return "", fmt.Errorf("cnos: resolve var source auth secret %q: %w", ref, err)
	}
	if !found {
		return "", fmt.Errorf("cnos: var source auth secret %q unresolved", ref)
	}
	token, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("cnos: var source auth secret %q is not a string", ref)
	}
	return token, nil
}

// pullScope dispatches a group pull to the built-in http client or to a registered
// transport provider, normalizing both onto the same pullResult.
func (variables *varRuntime) pullScope(ctx context.Context, sourceName string, source VarSourceDef, group, knownRevision string) (pullResult, error) {
	if isBuiltinTransport(source.Transport) {
		return variables.pull(ctx, source, "group", group, knownRevision)
	}

	provider, err := variables.providerFor(sourceName, source)
	if err != nil {
		return pullResult{}, err
	}

	batch, err := provider.Pull(ctx, VarScope{Group: group}, knownRevision)
	if err != nil {
		return pullResult{}, err
	}

	return pullResult{
		status:      batch.Status,
		generation:  batch.Generation,
		revision:    batch.Revision,
		schemaId:    batch.SchemaId,
		effectiveAt: batch.EffectiveAt,
		values:      batch.Values,
	}, nil
}

// sourceCanSubscribe reports whether a source's provider implements VarSubscribingProvider —
// the capability that decides whether the source is polled (see startPollers). The built-in http
// client is pull-only by construction. Warns once per source when a subscribe-capable source
// also declares a pollInterval, so an ignored manifest setting is never silent.
func (variables *varRuntime) sourceCanSubscribe(sourceName string, source VarSourceDef) bool {
	if isBuiltinTransport(source.Transport) {
		return false
	}

	provider, err := variables.providerFor(sourceName, source)
	if err != nil {
		// No provider module registered: nothing subscribes and nothing can poll either.
		return false
	}

	if _, ok := provider.(VarSubscribingProvider); !ok {
		return false
	}

	variables.mu.Lock()
	warned := variables.warnedPollInterval[sourceName]
	if !warned {
		if variables.warnedPollInterval == nil {
			variables.warnedPollInterval = map[string]bool{}
		}
		variables.warnedPollInterval[sourceName] = true
	}
	variables.mu.Unlock()

	if !warned {
		fmt.Fprintf(
			os.Stderr,
			"cnos [warn]: var source %q declares pollInterval but its transport (%q) supports subscribe; the subscription is authoritative and pollInterval is ignored. Remove it from the manifest to silence this warning\n",
			sourceName, source.Transport,
		)
	}
	return true
}

// startSubscriptions opens a live subscription per prefetch source whose provider
// implements VarSubscribingProvider. Pushed batches route through the SAME validated ingest
// path as pulls; pollers still cover pull-only (http) sources. Capability-keyed, never
// keyed off the transport name.
func (variables *varRuntime) startSubscriptions() {
	if variables.isClosed() {
		return
	}

	scopesBySource := map[string][]VarScope{}
	for group, def := range variables.groups {
		if def.Mode != "prefetch" {
			continue
		}
		scopesBySource[def.Source] = append(scopesBySource[def.Source], VarScope{Group: group})
	}

	for sourceName, scopes := range scopesBySource {
		source, ok := variables.sources[sourceName]
		if !ok || isBuiltinTransport(source.Transport) {
			continue
		}

		provider, err := variables.providerFor(sourceName, source)
		if err != nil {
			continue
		}

		subscriber, ok := provider.(VarSubscribingProvider)
		if !ok {
			continue
		}

		stop, err := subscriber.Subscribe(variables.ctx, scopes, variables.ingestSubscribed)
		if err != nil {
			variables.reportSubscriptionError(sourceName)(err, true, scopeStrings(scopes))
			continue
		}

		for _, scope := range scopes {
			variables.recordSubscription(groupFromVarKey(scope.Scope()), VarSubscriptionActive, "", 0)
		}

		variables.mu.Lock()
		variables.subscriptions = append(variables.subscriptions, stop)
		variables.mu.Unlock()
	}
}

// scopeStrings flattens scopes onto their wire strings.
func scopeStrings(scopes []VarScope) []string {
	result := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if value := scope.Scope(); value != "" {
			result = append(result, value)
		}
	}
	return result
}

// ingestSubscribed routes a pushed result through the SAME validated paths as a pull, deriving
// its group from the batch scope (or, failing that, from the full-key-keyed values).
//
// A pushed VarPullNoHead is a DEACTIVATION and clears the scope's runtime tier. Dropping it — as
// this did — left an rpc consumer serving a deactivated revision indefinitely, because a
// subscribe-capable source runs no poller and therefore has no pull to converge on.
func (variables *varRuntime) ingestSubscribed(batch VarBatchResult) {
	if batch.Status == VarPullNoHead {
		if batch.Scope != "" {
			variables.applyNoHead(batch.Scope)
		}
		return
	}

	if batch.Status != VarPullOK || len(batch.Values) == 0 {
		return
	}

	scope := batch.Scope
	if scope == "" {
		for key := range batch.Values {
			scope = groupFromVarKey(key)
			break
		}
	}
	group := groupFromVarKey(scope)
	if group == "" {
		return
	}

	_ = variables.ingest(varBatch{
		scope:       scope,
		group:       group,
		generation:  batch.Generation,
		revision:    batch.Revision,
		schemaId:    batch.SchemaId,
		effectiveAt: batch.EffectiveAt,
		values:      batch.Values,
	}, "subscribe")
}
