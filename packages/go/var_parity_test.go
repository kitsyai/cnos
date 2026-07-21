package cnos

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// SHARED SEMANTIC PARITY SUITE for var.*.
//
// Twin of packages/cnos/test/var-parity.test.ts. Both read the SAME declarative scenario files
// under fixtures/var-parity/scenarios/ and drive their own SDK's public surface against an
// in-process fake source. The wire is already pinned by fixtures/var-cross-sdk/; this pins the
// SEMANTICS — lifecycle, overlay tiers, deactivation, ordering, watcher dispatch, freshness,
// status, close — which is where every one of the 16 review findings lived.
//
// Assertions are on observable public results only (values, tier, freshness, start/refresh
// outcome KIND, status fields, watcher fire sequences). Internals are never asserted; they
// legitimately differ. See fixtures/var-parity/README.md for the format and divergence policy.

// --- spec model -------------------------------------------------------------

type parityResponse struct {
	Kind        string         `json:"kind"`
	Generation  int64          `json:"generation"`
	Revision    string         `json:"revision"`
	SchemaId    string         `json:"schemaId"`
	EffectiveAt string         `json:"effectiveAt"`
	Values      map[string]any `json:"values"`
	Message     string         `json:"message"`
}

type parityStep struct {
	Action  string          `json:"action"`
	Key     string          `json:"key"`
	ID      string          `json:"id"`
	Scope   string          `json:"scope"`
	Ms      int             `json:"ms"`
	Count   int             `json:"count"`
	Timeout int             `json:"timeoutMs"`
	Source  string          `json:"source"`
	Note    string          `json:"note"`
	ADR     string          `json:"adr"`
	Resp    *parityResponse `json:"response"`
	Event   *parityResponse `json:"event"`
	Then    *parityStep     `json:"then"`

	StartOutcome    string `json:"startOutcome"`
	StartErrorKind  string `json:"startErrorKind"`
	StartErrCause   *bool  `json:"startErrorHasCause"`
	RefreshOutcome  string `json:"refreshOutcome"`
	RefreshErrKind  string `json:"refreshErrorKind"`
	CloseOutcome    string `json:"closeOutcome"`
	CloseSettledMs  *int   `json:"closeSettledWithinMs"`
	CloseSettledVal *bool  `json:"settled"`

	Read   map[string]any         `json:"read"`
	Status json.RawMessage        `json:"status"`
	Watch  *parityWatchExpect     `json:"watch"`
	Obs    map[string]*parityStep `json:"observed"`
}

type parityWatchExpect struct {
	ID        string           `json:"id"`
	Unordered bool             `json:"unordered"`
	Fires     []map[string]any `json:"fires"`
}

type parityScenario struct {
	Name       string `json:"name"`
	Axis       string `json:"axis"`
	Why        string `json:"why"`
	Projection struct {
		Values     map[string]any `json:"values"`
		VarSources map[string]struct {
			Transport    string `json:"transport"`
			PollInterval string `json:"pollInterval"`
		} `json:"varSources"`
		Vars   map[string]VarGroupDef `json:"vars"`
		Schema map[string]VarKeyRule  `json:"schema"`
	} `json:"projection"`
	Source map[string]parityResponse `json:"source"`
	Steps  []parityStep              `json:"steps"`
}

// parityTransportAlias maps the spec's transport aliases. "fake" is the in-process parity
// source; "missing" names a transport with NO registered provider (the deployment-gap axis).
var parityTransportAlias = map[string]string{"fake": "ws", "missing": "sse"}

func loadParityScenarios(t *testing.T) []parityScenario {
	t.Helper()
	dir := filepath.Join("..", "..", "fixtures", "var-parity", "scenarios")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read parity scenario dir: %v", err)
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatalf("no parity scenario files in %s", dir)
	}

	scenarios := make([]parityScenario, 0, 32)
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		var batch []parityScenario
		if err := json.Unmarshal(data, &batch); err != nil {
			t.Fatalf("parse %s (must be an ARRAY of scenarios): %v", name, err)
		}
		scenarios = append(scenarios, batch...)
	}
	return scenarios
}

// --- the fake source --------------------------------------------------------

type paritySource struct {
	mu          sync.Mutex
	responses   map[string]parityResponse
	pulls       map[string]int
	gates       map[string]chan struct{}
	subscribers []func(VarBatchResult)
}

func newParitySource(initial map[string]parityResponse) *paritySource {
	source := &paritySource{
		responses: map[string]parityResponse{},
		pulls:     map[string]int{},
		gates:     map[string]chan struct{}{},
	}
	for scope, response := range initial {
		source.responses[scope] = response
	}
	return source
}

func (source *paritySource) set(scope string, response parityResponse) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.responses[scope] = response
}

func (source *paritySource) pullCount(scope string) int {
	source.mu.Lock()
	defer source.mu.Unlock()
	return source.pulls[scope]
}

func (source *paritySource) block(scope string) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.gates[scope] = make(chan struct{})
}

func (source *paritySource) release(scope string) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	gate, ok := source.gates[scope]
	if !ok {
		return fmt.Errorf("releasePull: scope %q is not blocked", scope)
	}
	delete(source.gates, scope)
	close(gate)
	return nil
}

func (source *paritySource) releaseAll() {
	source.mu.Lock()
	defer source.mu.Unlock()
	for scope, gate := range source.gates {
		delete(source.gates, scope)
		close(gate)
	}
}

func (source *paritySource) push(scope string, event parityResponse) error {
	source.mu.Lock()
	subscribers := append([]func(VarBatchResult){}, source.subscribers...)
	source.mu.Unlock()

	if len(subscribers) == 0 {
		return fmt.Errorf("push to scope %q: no subscription is open (only PREFETCH groups subscribe in both SDKs)", scope)
	}

	result := VarBatchResult{Status: VarPullNoHead, Scope: scope}
	if event.Kind == "batch" {
		result = VarBatchResult{
			Status:      VarPullOK,
			Scope:       scope,
			Generation:  event.Generation,
			Revision:    event.Revision,
			SchemaId:    event.SchemaId,
			EffectiveAt: event.EffectiveAt,
			Values:      event.Values,
		}
	}
	for _, subscriber := range subscribers {
		subscriber(result)
	}
	return nil
}

// parityProvider is the transport provider both the pull and the push paths run through. It
// implements VarSubscribingProvider, so — per the canonical capability rule — the SDK never
// polls it.
type parityProvider struct{ source *paritySource }

func (provider *parityProvider) Pull(ctx context.Context, scope VarScope, knownRevision string) (VarBatchResult, error) {
	key := scope.Scope()

	provider.source.mu.Lock()
	provider.source.pulls[key]++
	gate := provider.source.gates[key]
	provider.source.mu.Unlock()

	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return VarBatchResult{}, ctx.Err()
		}
	}

	provider.source.mu.Lock()
	response, ok := provider.source.responses[key]
	provider.source.mu.Unlock()
	if !ok {
		response = parityResponse{Kind: "no-head"}
	}

	switch response.Kind {
	case "no-head":
		return VarBatchResult{Status: VarPullNoHead, Scope: key}, nil
	case "not-modified":
		return VarBatchResult{Status: VarPullNotModified, Scope: key}, nil
	case "error":
		message := response.Message
		if message == "" {
			message = "fake transport failure"
		}
		return VarBatchResult{}, errors.New(message)
	}

	return VarBatchResult{
		Status:      VarPullOK,
		Scope:       key,
		Generation:  response.Generation,
		Revision:    response.Revision,
		SchemaId:    response.SchemaId,
		EffectiveAt: response.EffectiveAt,
		Values:      response.Values,
	}, nil
}

func (provider *parityProvider) Subscribe(_ context.Context, _ []VarScope, onBatch func(VarBatchResult)) (func(), error) {
	provider.source.mu.Lock()
	provider.source.subscribers = append(provider.source.subscribers, onBatch)
	index := len(provider.source.subscribers) - 1
	provider.source.mu.Unlock()

	return func() {
		provider.source.mu.Lock()
		defer provider.source.mu.Unlock()
		if index < len(provider.source.subscribers) {
			provider.source.subscribers[index] = func(VarBatchResult) {}
		}
	}, nil
}

func (provider *parityProvider) Close() error { return nil }

// --- runner -----------------------------------------------------------------

type parityOutcome struct {
	outcome string
	kind    string
	err     error
}

type parityFire struct {
	Source    string `json:"source"`
	Value     any    `json:"value"`
	Freshness string `json:"freshness"`
}

type parityWatcher struct {
	stop  func()
	fires []parityFire
}

type parityRead struct {
	found     bool
	value     any
	source    string
	freshness string
}

type parityStatus struct {
	source            string
	freshness         string
	appliedGeneration int64
	revision          bool
	desiredGeneration bool
	lastError         bool
	lastRejected      bool
}

type parityRunner struct {
	t        *testing.T
	scenario parityScenario
	runtime  *Runtime
	source   *paritySource

	mu       sync.Mutex
	watchers map[string]*parityWatcher

	startDone    chan struct{}
	startOutcome parityOutcome
	refreshDone  chan struct{}
	refreshOut   parityOutcome
	closeDone    chan struct{}
	closeOut     parityOutcome
	lastRead     *parityRead
}

// parityErrorKind maps a startup/refresh failure onto a cross-SDK error KIND. Messages are
// never compared across SDKs; the kind is.
func parityErrorKind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrVarRequired):
		return "required"
	case errors.Is(err, ErrVarClosed):
		return "closed"
	default:
		return "other"
	}
}

func newParityRunner(t *testing.T, scenario parityScenario) *parityRunner {
	t.Helper()

	projection := baseVarProjection()
	for key, value := range scenario.Projection.Values {
		projection.Values[key] = value
	}

	projection.VarSources = map[string]VarSourceDef{}
	for name, definition := range scenario.Projection.VarSources {
		transport, ok := parityTransportAlias[definition.Transport]
		if !ok {
			t.Fatalf("unsupported spec transport %q (use \"fake\" or \"missing\")", definition.Transport)
		}
		projection.VarSources[name] = VarSourceDef{
			Transport:    transport,
			URL:          "parity://fake",
			PollInterval: definition.PollInterval,
		}
	}
	projection.Vars = scenario.Projection.Vars
	projection.Schema = scenario.Projection.Schema
	if projection.Vars == nil {
		projection.Vars = map[string]VarGroupDef{}
	}
	if projection.Schema == nil {
		projection.Schema = map[string]VarKeyRule{}
	}

	source := newParitySource(scenario.Source)
	payload, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}
	runtime, err := LoadProjection(payload, Options{
		SecretHome:  t.TempDir(),
		Environment: map[string]string{},
		VarSourceProviders: []VarSourceProviderFactory{{
			Transport: "ws",
			Create: func(def VarSourceDef, providerCtx VarProviderContext) (VarSourceProvider, error) {
				return &parityProvider{source: source}, nil
			},
		}},
	})
	if err != nil {
		t.Fatalf("load projection: %v", err)
	}

	return &parityRunner{
		t:        t,
		scenario: scenario,
		runtime:  runtime,
		source:   source,
		watchers: map[string]*parityWatcher{},
	}
}

func (runner *parityRunner) run() {
	defer func() {
		runner.mu.Lock()
		for _, watcher := range runner.watchers {
			watcher.stop()
		}
		runner.mu.Unlock()
		runner.source.releaseAll()
		if runner.startDone != nil {
			<-runner.startDone
		}
		if runner.refreshDone != nil {
			<-runner.refreshDone
		}
		if runner.closeDone != nil {
			<-runner.closeDone
		}
		_ = runner.runtime.Close()
	}()

	for index, step := range runner.scenario.Steps {
		runner.step(index, step)
	}
}

func (runner *parityRunner) step(index int, step parityStep) {
	label := fmt.Sprintf("%s step %d (%s)", runner.scenario.Name, index, step.Action)

	switch step.Action {
	case "start":
		runner.startAsync()
		runner.awaitStart(label)
	case "startAsync":
		runner.startAsync()
	case "awaitStart":
		runner.awaitStart(label)
	case "close":
		runner.closeAsync()
		runner.awaitClose(label)
	case "closeAsync":
		runner.closeAsync()
	case "awaitClose":
		runner.awaitClose(label)
	case "setSource":
		runner.source.set(runner.requireScope(label, step), derefResponse(step.Resp))
	case "blockPull":
		runner.source.block(runner.requireScope(label, step))
	case "releasePull":
		if err := runner.source.release(runner.requireScope(label, step)); err != nil {
			runner.t.Fatalf("%s: %v", label, err)
		}
	case "awaitPullIssued":
		runner.awaitPullIssued(label, runner.requireScope(label, step), maxInt(step.Count, 1), timeoutOf(step))
	case "push":
		if err := runner.source.push(runner.requireScope(label, step), derefResponse(step.Event)); err != nil {
			runner.t.Fatalf("%s: %v", label, err)
		}
	case "read":
		result := runner.read(runner.requireKey(label, step))
		runner.lastRead = &result
	case "awaitRead":
		runner.awaitRead(label, runner.requireKey(label, step), defaultString(step.Source, "runtime"), timeoutOf(step))
	case "refreshVars":
		runner.refreshVarsAsync()
		runner.awaitRefresh(label)
	case "refreshVarsAsync":
		runner.refreshVarsAsync()
	case "refreshVar":
		runner.refreshVarAsync(runner.requireKey(label, step))
		runner.awaitRefresh(label)
	case "awaitRefresh":
		runner.awaitRefresh(label)
	case "watch":
		runner.watch(label, step)
	case "unwatch":
		runner.mu.Lock()
		watcher, ok := runner.watchers[step.ID]
		runner.mu.Unlock()
		if !ok {
			runner.t.Fatalf("%s: no watcher registered as %q", label, step.ID)
		}
		watcher.stop()
	case "sleep":
		time.Sleep(time.Duration(step.Ms) * time.Millisecond)
	case "expect":
		runner.expect(label, step)
	default:
		// A scenario the runner cannot express FAILS LOUDLY. Silent skips are how this feature
		// accumulated tests that asserted nothing.
		runner.t.Fatalf("%s: UNSUPPORTED parity action %q — extend BOTH runners or drop the scenario", label, step.Action)
	}
}

func (runner *parityRunner) requireScope(label string, step parityStep) string {
	if step.Scope == "" {
		runner.t.Fatalf("%s: requires a \"scope\"", label)
	}
	return step.Scope
}

func (runner *parityRunner) requireKey(label string, step parityStep) string {
	if step.Key == "" {
		runner.t.Fatalf("%s: requires a \"key\"", label)
	}
	return step.Key
}

func (runner *parityRunner) startAsync() {
	done := make(chan struct{})
	runner.startDone = done
	go func() {
		err := runner.runtime.StartVars(context.Background())
		runner.mu.Lock()
		if err == nil {
			runner.startOutcome = parityOutcome{outcome: "ok"}
		} else {
			runner.startOutcome = parityOutcome{outcome: "error", kind: parityErrorKind(err), err: err}
		}
		runner.mu.Unlock()
		close(done)
	}()
}

func (runner *parityRunner) awaitStart(label string) {
	if runner.startDone == nil {
		runner.t.Fatalf("%s: no start attempt is in flight", label)
	}
	select {
	case <-runner.startDone:
	case <-time.After(20 * time.Second):
		runner.t.Fatalf("%s: StartVars never returned", label)
	}
}

func (runner *parityRunner) closeAsync() {
	done := make(chan struct{})
	runner.closeDone = done
	go func() {
		err := runner.runtime.Close()
		runner.mu.Lock()
		if err == nil {
			runner.closeOut = parityOutcome{outcome: "ok"}
		} else {
			runner.closeOut = parityOutcome{outcome: "error", kind: parityErrorKind(err)}
		}
		runner.mu.Unlock()
		close(done)
	}()
}

func (runner *parityRunner) awaitClose(label string) {
	if runner.closeDone == nil {
		runner.t.Fatalf("%s: no close is in flight", label)
	}
	select {
	case <-runner.closeDone:
	case <-time.After(20 * time.Second):
		runner.t.Fatalf("%s: Close never returned", label)
	}
}

func (runner *parityRunner) refreshVarsAsync() {
	done := make(chan struct{})
	runner.refreshDone = done
	go func() {
		err := runner.runtime.RefreshVars(context.Background())
		runner.mu.Lock()
		if err == nil {
			runner.refreshOut = parityOutcome{outcome: "ok"}
		} else {
			runner.refreshOut = parityOutcome{outcome: "error", kind: parityErrorKind(err)}
		}
		runner.mu.Unlock()
		close(done)
	}()
}

func (runner *parityRunner) refreshVarAsync(key string) {
	done := make(chan struct{})
	runner.refreshDone = done
	go func() {
		err := runner.runtime.RefreshVar(context.Background(), strings.TrimPrefix(key, "var."))
		runner.mu.Lock()
		if err == nil {
			runner.refreshOut = parityOutcome{outcome: "ok"}
		} else {
			runner.refreshOut = parityOutcome{outcome: "error", kind: parityErrorKind(err)}
		}
		runner.mu.Unlock()
		close(done)
	}()
}

func (runner *parityRunner) awaitRefresh(label string) {
	if runner.refreshDone == nil {
		runner.t.Fatalf("%s: no refresh is in flight", label)
	}
	select {
	case <-runner.refreshDone:
	case <-time.After(20 * time.Second):
		runner.t.Fatalf("%s: refresh never returned", label)
	}
}

func (runner *parityRunner) watch(label string, step parityStep) {
	key := runner.requireKey(label, step)
	watcher := &parityWatcher{stop: func() {}}
	reentrantDone := false

	stop := runner.runtime.Watch(key, func(next, _ Snapshot) {
		runner.mu.Lock()
		watcher.fires = append(watcher.fires, parityFire{
			Source:    string(next.Source),
			Value:     next.Value,
			Freshness: string(next.Freshness),
		})
		fire := step.Then != nil && !reentrantDone
		if fire {
			reentrantDone = true
		}
		runner.mu.Unlock()

		if fire {
			runner.step(-1, *step.Then)
		}
	})
	watcher.stop = stop

	runner.mu.Lock()
	runner.watchers[step.ID] = watcher
	runner.mu.Unlock()
}

func (runner *parityRunner) read(key string) parityRead {
	path := strings.TrimPrefix(key, "var.")
	value, found, err := runner.runtime.Var(path)
	if err != nil {
		runner.t.Fatalf("read %q: %v", key, err)
	}
	snapshot, _ := runner.runtime.VarSnapshot(path)
	return parityRead{
		found:     found,
		value:     value,
		source:    string(snapshot.Source),
		freshness: string(snapshot.Freshness),
	}
}

func (runner *parityRunner) status(label, key string) parityStatus {
	stripped := strings.TrimPrefix(key, "var.")
	entry, ok := runner.runtime.VarStatus()[stripped]
	if !ok {
		runner.t.Fatalf("%s: VarStatus() has no entry for %q", label, stripped)
	}
	return parityStatus{
		source:            string(entry.Source),
		freshness:         string(entry.Freshness),
		appliedGeneration: entry.AppliedGeneration,
		revision:          entry.Revision != "",
		desiredGeneration: entry.DesiredGeneration != nil,
		lastError:         entry.LastError != "",
		lastRejected:      entry.LastRejected != nil,
	}
}

func (runner *parityRunner) awaitPullIssued(label, scope string, count, timeoutMs int) {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for time.Now().Before(deadline) {
		if runner.source.pullCount(scope) >= count {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	runner.t.Fatalf("%s: scope %q saw %d pulls, expected at least %d", label, scope, runner.source.pullCount(scope), count)
}

func (runner *parityRunner) awaitRead(label, key, source string, timeoutMs int) {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for time.Now().Before(deadline) {
		result := runner.read(key)
		runner.lastRead = &result
		if result.source == source {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	runner.t.Fatalf("%s: %q never reached source %q", label, key, source)
}

// --- assertions -------------------------------------------------------------

func (runner *parityRunner) expect(label string, step parityStep) {
	if isDivergentStatus(step.Status) {
		observed, ok := step.Obs["go"]
		if !ok || observed == nil {
			runner.t.Fatalf("%s: divergent expectation has no observed.go block", label)
		}
		recordParityDivergence(runner.scenario.Name, step.Note)
		// The divergence is REPORTED, not tolerated: the Go side must still match exactly what
		// the spec records for it. If it drifts again, this fails.
		runner.assertAll(label+" [known divergence]", *observed)
		return
	}
	runner.assertAll(label, step)
}

func (runner *parityRunner) assertAll(label string, step parityStep) {
	runner.mu.Lock()
	startOutcome := runner.startOutcome
	refreshOut := runner.refreshOut
	closeOut := runner.closeOut
	runner.mu.Unlock()

	if step.StartOutcome != "" && startOutcome.outcome != step.StartOutcome {
		runner.t.Fatalf("%s: startOutcome = %q, want %q", label, startOutcome.outcome, step.StartOutcome)
	}
	if step.StartErrorKind != "" && startOutcome.kind != step.StartErrorKind {
		runner.t.Fatalf("%s: startErrorKind = %q, want %q", label, startOutcome.kind, step.StartErrorKind)
	}
	if step.StartErrCause != nil {
		// DECISION 1: the ErrVarRequired startup failure preserves the underlying transport error
		// in its unwrap chain (errors.Join), so a caller gets both the rule and the actionable cause.
		got := hasUnderlyingCause(startOutcome.err)
		if got != *step.StartErrCause {
			runner.t.Fatalf("%s: startErrorHasCause = %v, want %v", label, got, *step.StartErrCause)
		}
	}
	if step.RefreshOutcome != "" && refreshOut.outcome != step.RefreshOutcome {
		runner.t.Fatalf("%s: refreshOutcome = %q, want %q", label, refreshOut.outcome, step.RefreshOutcome)
	}
	if step.RefreshErrKind != "" && refreshOut.kind != step.RefreshErrKind {
		runner.t.Fatalf("%s: refreshErrorKind = %q, want %q", label, refreshOut.kind, step.RefreshErrKind)
	}
	if step.CloseOutcome != "" && closeOut.outcome != step.CloseOutcome {
		runner.t.Fatalf("%s: closeOutcome = %q, want %q", label, closeOut.outcome, step.CloseOutcome)
	}

	if step.CloseSettledMs != nil {
		want := true
		if step.CloseSettledVal != nil {
			want = *step.CloseSettledVal
		}
		if got := runner.closeSettledWithin(label, *step.CloseSettledMs); got != want {
			runner.t.Fatalf("%s: closeSettledWithin(%dms) = %v, want %v", label, *step.CloseSettledMs, got, want)
		}
	}

	if step.Read != nil {
		if runner.lastRead == nil {
			runner.t.Fatalf("%s: a `read` expectation needs a preceding read/awaitRead step", label)
		}
		for field, want := range step.Read {
			var got any
			switch field {
			case "found":
				got = runner.lastRead.found
			case "value":
				got = runner.lastRead.value
			case "source":
				got = runner.lastRead.source
			case "freshness":
				got = runner.lastRead.freshness
			default:
				runner.t.Fatalf("%s: unknown read assertion %q", label, field)
			}
			if !equalJSON(got, want) {
				runner.t.Fatalf("%s: read.%s = %#v, want %#v", label, field, got, want)
			}
		}
	}

	if len(step.Status) > 0 && !isDivergentStatus(step.Status) {
		wanted := map[string]any{}
		if err := json.Unmarshal(step.Status, &wanted); err != nil {
			runner.t.Fatalf("%s: malformed status expectation: %v", label, err)
		}
		key, _ := wanted["key"].(string)
		if key == "" {
			runner.t.Fatalf("%s: a `status` expectation needs a \"key\"", label)
		}
		actual := runner.status(label, key)
		for field, want := range wanted {
			if field == "key" {
				continue
			}
			var got any
			switch field {
			case "source":
				got = actual.source
			case "freshness":
				got = actual.freshness
			case "appliedGeneration":
				got = actual.appliedGeneration
			case "revision":
				got = actual.revision
			case "desiredGeneration":
				got = actual.desiredGeneration
			case "lastError":
				got = actual.lastError
			case "lastRejected":
				got = actual.lastRejected
			default:
				runner.t.Fatalf("%s: unknown status assertion %q", label, field)
			}
			if !equalJSON(got, want) {
				runner.t.Fatalf("%s: status.%s = %#v, want %#v", label, field, got, want)
			}
		}
	}

	if step.Watch != nil {
		runner.mu.Lock()
		watcher, ok := runner.watchers[step.Watch.ID]
		var fires []parityFire
		if ok {
			fires = append(fires, watcher.fires...)
		}
		runner.mu.Unlock()
		if !ok {
			runner.t.Fatalf("%s: a `watch` expectation names an unregistered watcher %q", label, step.Watch.ID)
		}

		got := make([]string, 0, len(fires))
		for _, fire := range fires {
			got = append(got, canonicalFire(fire.Source, fire.Value))
		}
		want := make([]string, 0, len(step.Watch.Fires))
		for _, fire := range step.Watch.Fires {
			want = append(want, canonicalFire(fmt.Sprint(fire["source"]), fire["value"]))
		}
		if step.Watch.Unordered {
			sort.Strings(got)
			sort.Strings(want)
		}
		if !reflect.DeepEqual(got, want) {
			runner.t.Fatalf("%s: watch(%s).fires = %v, want %v", label, step.Watch.ID, got, want)
		}
	}
}

func (runner *parityRunner) closeSettledWithin(label string, ms int) bool {
	if runner.closeDone == nil {
		runner.t.Fatalf("%s: closeSettledWithin needs an in-flight close()", label)
	}
	select {
	case <-runner.closeDone:
		return true
	case <-time.After(time.Duration(ms) * time.Millisecond):
		return false
	}
}

// --- helpers ----------------------------------------------------------------

func isDivergentStatus(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text == "divergent"
	}
	return false
}

// equalJSON compares an observed Go value with a JSON-decoded expectation through their JSON
// encodings, so an int64 generation and a JSON number compare equal without type gymnastics.
func equalJSON(got, want any) bool {
	gotData, err := json.Marshal(got)
	if err != nil {
		return false
	}
	wantData, err := json.Marshal(want)
	if err != nil {
		return false
	}
	var gotValue, wantValue any
	_ = json.Unmarshal(gotData, &gotValue)
	_ = json.Unmarshal(wantData, &wantValue)
	return reflect.DeepEqual(gotValue, wantValue)
}

// hasUnderlyingCause reports whether err carries a real underlying cause beyond the
// ErrVarRequired sentinel — i.e. the transport error was preserved (via errors.Join) rather than
// stringified away. An errors.Join of the sentinel-wrap and the transport error exposes both
// through Unwrap() []error; a bare fmt.Errorf("%w", ErrVarRequired) exposes only the sentinel.
func hasUnderlyingCause(err error) bool {
	if err == nil {
		return false
	}
	switch x := err.(type) {
	case interface{ Unwrap() []error }:
		return len(x.Unwrap()) > 1
	case interface{ Unwrap() error }:
		inner := x.Unwrap()
		return inner != nil && !errors.Is(inner, ErrVarRequired)
	}
	return false
}

func canonicalFire(source string, value any) string {
	data, _ := json.Marshal(map[string]any{"source": source, "value": value})
	return string(data)
}

func derefResponse(response *parityResponse) parityResponse {
	if response == nil {
		return parityResponse{Kind: "no-head"}
	}
	return *response
}

func timeoutOf(step parityStep) int {
	if step.Timeout > 0 {
		return step.Timeout
	}
	return 3000
}

func maxInt(value, floor int) int {
	if value < floor {
		return floor
	}
	return value
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

var (
	parityDivergenceMu  sync.Mutex
	parityDivergenceLog []string
)

func recordParityDivergence(scenario, note string) {
	parityDivergenceMu.Lock()
	defer parityDivergenceMu.Unlock()
	parityDivergenceLog = append(parityDivergenceLog, fmt.Sprintf("%s: %s", scenario, note))
}

// --- suite ------------------------------------------------------------------

func TestVarSemanticParity(t *testing.T) {
	scenarios := loadParityScenarios(t)
	if len(scenarios) <= 20 {
		t.Fatalf("expected the shared parity spec to carry more than 20 scenarios, got %d", len(scenarios))
	}

	seen := map[string]bool{}
	for _, scenario := range scenarios {
		if scenario.Name == "" || scenario.Why == "" || scenario.Axis == "" || len(scenario.Steps) == 0 {
			t.Fatalf("malformed parity scenario: %+v", scenario)
		}
		if seen[scenario.Name] {
			t.Fatalf("duplicate parity scenario %q", scenario.Name)
		}
		seen[scenario.Name] = true
	}

	for _, scenario := range scenarios {
		scenario := scenario
		t.Run(scenario.Axis+"/"+scenario.Name, func(t *testing.T) {
			newParityRunner(t, scenario).run()
		})
	}

	parityDivergenceMu.Lock()
	defer parityDivergenceMu.Unlock()
	if len(parityDivergenceLog) > 0 {
		t.Logf("%d KNOWN Node/Go divergence(s) exercised (recorded in the spec, not failures):\n  - %s",
			len(parityDivergenceLog), strings.Join(parityDivergenceLog, "\n  - "))
	}
}
