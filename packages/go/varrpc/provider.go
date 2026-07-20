// Package varrpc provides the rpc (gRPC) transport for CNOS runtime variables (var.*).
//
// It is a separate Go module so that the core `packages/go` SDK stays free of the gRPC
// dependency: applications that use an rpc var source import this module and register its
// factory, exactly like a secret vault provider submodule.
//
//	import (
//	    cnos "github.com/kitsyai/cnos/packages/go"
//	    "github.com/kitsyai/cnos/packages/go/varrpc"
//	)
//
//	err := cnos.Ready(cnos.Options{VarSourceProviders: []cnos.VarSourceProviderFactory{varrpc.Factory()}})
package varrpc

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"regexp"
	"strings"
	"sync"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// Transport is the manifest transport name this provider serves.
const Transport = "rpc"

var schemePrefix = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]*://`)

// grpcTarget strips a URL scheme so a manifest `url` maps onto a bare gRPC host:port target.
func grpcTarget(url string) string {
	return strings.TrimRight(schemePrefix.ReplaceAllString(url, ""), "/")
}

// Option configures the provider factory.
type Option func(*options)

type options struct {
	dialOptions []grpc.DialOption
	conn        grpc.ClientConnInterface
	// backoffBase/backoffCeiling let tests drive reconnect quickly.
	backoffBase    time.Duration
	backoffCeiling time.Duration
}

// WithDialOptions appends gRPC dial options (TLS credentials, interceptors, keepalive).
func WithDialOptions(dialOptions ...grpc.DialOption) Option {
	return func(o *options) { o.dialOptions = append(o.dialOptions, dialOptions...) }
}

// WithClientConn injects an existing connection, primarily for tests or shared channels.
// The provider does not close an injected connection.
func WithClientConn(conn grpc.ClientConnInterface) Option {
	return func(o *options) { o.conn = conn }
}

// WithBackoff overrides the reconnect backoff window (base and ceiling).
func WithBackoff(base, ceiling time.Duration) Option {
	return func(o *options) {
		o.backoffBase = base
		o.backoffCeiling = ceiling
	}
}

// Factory returns a CNOS var source provider factory for the rpc transport.
func Factory(configure ...Option) cnos.VarSourceProviderFactory {
	return cnos.VarSourceProviderFactory{
		Transport: Transport,
		Create: func(def cnos.VarSourceDef, providerCtx cnos.VarProviderContext) (cnos.VarSourceProvider, error) {
			return New(def, providerCtx, configure...)
		},
	}
}

// Provider is the rpc VarSourceProvider: Pull + Subscribe over `cnos.var.v1.VarService`,
// with metadata bearer auth resolved from the source's secret ref and reconnect/backoff
// owned entirely by the SDK.
type Provider struct {
	client         *varServiceClient
	conn           *grpc.ClientConn // nil when a connection was injected
	bearerRef      string
	resolveSecret  func(ref string) (string, error)
	backoffBase    time.Duration
	backoffCeiling time.Duration

	mu      sync.Mutex
	closed  bool
	cancels []context.CancelFunc
}

// New builds a provider for one var source definition.
func New(def cnos.VarSourceDef, providerCtx cnos.VarProviderContext, configure ...Option) (*Provider, error) {
	settings := options{backoffBase: 500 * time.Millisecond, backoffCeiling: 30 * time.Second}
	for _, apply := range configure {
		apply(&settings)
	}

	provider := &Provider{
		bearerRef:      def.Auth["bearer"],
		resolveSecret:  providerCtx.ResolveSecret,
		backoffBase:    settings.backoffBase,
		backoffCeiling: settings.backoffCeiling,
	}

	if settings.conn != nil {
		provider.client = newVarServiceClient(settings.conn)
		return provider, nil
	}

	target := grpcTarget(def.URL)
	if target == "" {
		return nil, fmt.Errorf("varrpc: var source has no url to dial")
	}

	dialOptions := settings.dialOptions
	if len(dialOptions) == 0 {
		dialOptions = []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	}

	conn, err := grpc.NewClient(target, dialOptions...)
	if err != nil {
		return nil, fmt.Errorf("varrpc: dial %q: %w", target, err)
	}

	provider.conn = conn
	provider.client = newVarServiceClient(conn)
	return provider, nil
}

// authContext attaches the bearer token (resolved from the source's secret ref) as gRPC
// metadata, mirroring the http transport's Authorization header.
func (provider *Provider) authContext(ctx context.Context) (context.Context, error) {
	if provider.bearerRef == "" || provider.resolveSecret == nil {
		return ctx, nil
	}
	token, err := provider.resolveSecret(provider.bearerRef)
	if err != nil {
		return nil, err
	}
	if token == "" {
		return ctx, nil
	}
	return metadata.NewOutgoingContext(ctx, metadata.Pairs("authorization", "Bearer "+token)), nil
}

// toResult maps a wire batch onto the SDK-facing result, applying the http-identical
// semantics: not_modified ≙ 304 (keep cache), no_head ≙ 404 no-head (overlay fallback).
func toResult(fallbackScope string, batch *SnapshotBatch) (cnos.VarBatchResult, error) {
	scope := batch.Scope
	if scope == "" {
		scope = fallbackScope
	}

	if batch.NotModified {
		return cnos.VarBatchResult{Status: cnos.VarPullNotModified, Scope: scope}, nil
	}
	if batch.NoHead {
		return cnos.VarBatchResult{Status: cnos.VarPullNoHead, Scope: scope}, nil
	}

	values := map[string]any{}
	if len(batch.ValuesJSON) > 0 {
		if err := json.Unmarshal(batch.ValuesJSON, &values); err != nil {
			return cnos.VarBatchResult{}, fmt.Errorf("varrpc: decode values_json for scope %q: %w", scope, err)
		}
	}

	return cnos.VarBatchResult{
		Status:      cnos.VarPullOK,
		Scope:       scope,
		Generation:  batch.Generation,
		Revision:    batch.Revision,
		SchemaId:    batch.SchemaId,
		EffectiveAt: batch.EffectiveAt,
		Values:      values,
	}, nil
}

// Pull fetches the current head batch for a scope.
func (provider *Provider) Pull(ctx context.Context, scope cnos.VarScope, knownRevision string) (cnos.VarBatchResult, error) {
	scopeString := scope.Scope()
	if scopeString == "" {
		return cnos.VarBatchResult{}, fmt.Errorf("varrpc: VarScope must specify either a key or a group")
	}

	callCtx, err := provider.authContext(ctx)
	if err != nil {
		return cnos.VarBatchResult{}, err
	}

	batch, err := provider.client.Pull(callCtx, &PullRequest{Scope: scopeString, KnownRevision: knownRevision})
	if err != nil {
		return cnos.VarBatchResult{}, fmt.Errorf("varrpc: pull scope %q: %w", scopeString, err)
	}

	return toResult(scopeString, batch)
}

// Subscribe opens the Subscribe server-stream and feeds accepted activations to onBatch,
// reconnecting with capped exponential backoff + jitter until the returned stop function is
// called (or the provider is closed).
func (provider *Provider) Subscribe(ctx context.Context, scopes []cnos.VarScope, onBatch func(cnos.VarBatchResult)) (func(), error) {
	if len(scopes) == 0 {
		return func() {}, nil
	}

	scopeStrings := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if value := scope.Scope(); value != "" {
			scopeStrings = append(scopeStrings, value)
		}
	}
	if len(scopeStrings) == 0 {
		return func() {}, nil
	}

	provider.mu.Lock()
	if provider.closed {
		provider.mu.Unlock()
		return func() {}, fmt.Errorf("varrpc: provider is closed")
	}
	streamCtx, cancel := context.WithCancel(ctx)
	provider.cancels = append(provider.cancels, cancel)
	provider.mu.Unlock()

	go provider.subscribeLoop(streamCtx, scopeStrings, onBatch)

	var once sync.Once
	return func() { once.Do(cancel) }, nil
}

func (provider *Provider) subscribeLoop(ctx context.Context, scopes []string, onBatch func(cnos.VarBatchResult)) {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}

		delivered := provider.runStream(ctx, scopes, onBatch)

		if ctx.Err() != nil {
			return
		}

		// A stream that delivered at least one batch was healthy — restart the backoff ramp.
		if delivered {
			attempt = 0
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(provider.nextBackoff(attempt)):
		}
		attempt++
	}
}

// runStream runs one Subscribe stream to completion, reporting whether it delivered a batch.
func (provider *Provider) runStream(ctx context.Context, scopes []string, onBatch func(cnos.VarBatchResult)) bool {
	callCtx, err := provider.authContext(ctx)
	if err != nil {
		return false
	}

	stream, err := provider.client.Subscribe(callCtx, &SubscribeRequest{Scopes: scopes})
	if err != nil {
		return false
	}

	delivered := false
	for {
		batch, err := stream.Recv()
		if err != nil {
			return delivered
		}

		// Push-side deactivations (no_head) and no-change acks are not ingestable batches;
		// the SDK converges on the next pull.
		if batch.NotModified || batch.NoHead {
			continue
		}

		result, err := toResult("", batch)
		if err != nil {
			continue
		}

		delivered = true
		onBatch(result)
	}
}

// nextBackoff returns a capped exponential backoff with jitter, mirroring the core SDK's
// poller policy.
func (provider *Provider) nextBackoff(attempt int) time.Duration {
	next := provider.backoffBase
	for i := 0; i < attempt && next < provider.backoffCeiling; i++ {
		next *= 2
	}
	if next > provider.backoffCeiling {
		next = provider.backoffCeiling
	}
	if next <= 0 {
		next = time.Millisecond
	}
	return next + time.Duration(rand.Int63n(int64(next)/4+1))
}

// Close cancels every active subscription stream and closes the channel. Idempotent.
func (provider *Provider) Close() error {
	provider.mu.Lock()
	if provider.closed {
		provider.mu.Unlock()
		return nil
	}
	provider.closed = true
	cancels := provider.cancels
	provider.cancels = nil
	provider.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}

	if provider.conn != nil {
		return provider.conn.Close()
	}
	return nil
}
