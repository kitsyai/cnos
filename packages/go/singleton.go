package cnos

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

var (
	defaultRuntimeMu sync.Mutex
	defaultRuntime   *Runtime
)

var ErrRuntimeNotReady = fmt.Errorf("cnos: runtime not initialized. Call cnos.Ready() or load a runtime and set it as default")

func init() {
	bootstrapDefaultRuntime()
}

func SetDefaultRuntime(runtime *Runtime) {
	defaultRuntimeMu.Lock()
	defer defaultRuntimeMu.Unlock()
	defaultRuntime = runtime
}

func DefaultRuntime() (*Runtime, error) {
	defaultRuntimeMu.Lock()
	defer defaultRuntimeMu.Unlock()
	if defaultRuntime == nil {
		return nil, ErrRuntimeNotReady
	}
	return defaultRuntime, nil
}

func Ready(options ...Options) error {
	loadOptions := Options{}
	if len(options) > 0 {
		loadOptions = options[0]
	}

	defaultRuntimeMu.Lock()
	runtime := defaultRuntime
	defaultRuntimeMu.Unlock()

	if runtime != nil {
		if len(loadOptions.SecretVaultProviders) > 0 {
			runtime.RegisterSecretVaultProviders(loadOptions.SecretVaultProviders...)
		}
		if err := runtime.warmSecrets(); err != nil {
			return err
		}
		return runtime.StartVars(context.Background())
	}

	loaded, err := Load(loadOptions)
	if err != nil {
		return err
	}
	if err := loaded.warmSecrets(); err != nil {
		return err
	}
	if err := loaded.StartVars(context.Background()); err != nil {
		loaded.Close()
		return err
	}
	SetDefaultRuntime(loaded)
	return nil
}

func Read(key string) (any, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, false, err
	}
	return runtime.Read(key)
}

func Require(key string) (any, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.Require(key)
}

func ReadOr(key string, fallback any) (any, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.ReadOr(key, fallback)
}

func Value(path string) (any, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, false, err
	}
	return runtime.Value(path)
}

func Secret(path string) (any, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, false, err
	}
	return runtime.Secret(path)
}

func Meta(path string) (any, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, false, err
	}
	return runtime.Meta(path)
}

func Public(path string) (any, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, false, err
	}
	return runtime.Public(path)
}

// JSON returns the value at path as a map[string]any or []any via the default runtime.
// String values are JSON-parsed first.
func JSON(path string) (any, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, false, err
	}
	return runtime.JSON(path)
}

// PEM returns the value at path as a PEM string via the default runtime,
// normalising literal \n sequences to real newlines.
func PEM(path string) (string, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return "", false, err
	}
	return runtime.PEM(path)
}

func Inspect(key string) (InspectResult, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return InspectResult{}, err
	}
	return runtime.Inspect(key)
}

func ToObject() (map[string]any, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.ToObject()
}

func ToNamespace(namespace string) (map[string]any, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.ToNamespace(namespace)
}

func ToEnv(options ...ToEnvOptions) (map[string]string, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.ToEnv(options...)
}

func ToPublicEnv(options ...ToPublicEnvOptions) (map[string]string, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.ToPublicEnv(options...)
}

func ToServerProjection() (ServerProjection, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return ServerProjection{}, err
	}
	return runtime.ToServerProjection()
}

func Format(message string) (string, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return "", err
	}
	return runtime.Format(message)
}

func Log(message string) (string, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return "", err
	}
	return runtime.Log(message)
}

func RegisterRuntimeProvider(namespace string, provider RuntimeProvider) error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	return runtime.RegisterRuntimeProvider(namespace, provider)
}

// RegisterSecretVaultProviders adds remote secret vault provider factories to the default runtime.
func RegisterSecretVaultProviders(factories ...SecretVaultProviderFactory) error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	runtime.RegisterSecretVaultProviders(factories...)
	return nil
}

func RefreshSecrets() error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	return runtime.RefreshSecrets()
}

func RefreshSecret(path string) error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	return runtime.RefreshSecret(path)
}

func Projection() (ServerProjection, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return ServerProjection{}, err
	}
	return runtime.ToServerProjection()
}

// Var reads a var path via the default runtime's overlay precedence.
func Var(path string) (any, bool, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, false, err
	}
	return runtime.Var(path)
}

// VarSnapshot returns the in-memory var snapshot from the default runtime.
func VarSnapshot(key string) (Snapshot, bool) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return Snapshot{}, false
	}
	return runtime.VarSnapshot(key)
}

// RefreshVar refreshes a var key on the default runtime (honors ttl).
func RefreshVar(ctx context.Context, key string) error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	return runtime.RefreshVar(ctx, key)
}

// RefreshVars refreshes all var groups on the default runtime.
func RefreshVars(ctx context.Context) error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	return runtime.RefreshVars(ctx)
}

// Watch registers a var watcher on the default runtime.
func Watch(keyOrPrefix string, fn func(next, prev Snapshot)) (func(), error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.Watch(keyOrPrefix, fn), nil
}

// VarStatus returns the per-scope var observability document from the default runtime.
func VarStatus() (map[string]VarStatusEntry, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.VarStatus(), nil
}

// VarReceiver returns a latching push handler for a source from the default runtime.
func VarReceiver(source string) (http.Handler, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return nil, err
	}
	return runtime.VarReceiver(source), nil
}

// Close stops var pollers/goroutines and releases watchers on the default runtime.
func Close() error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	return runtime.Close()
}

func bootstrapDefaultRuntime() {
	defaultRuntimeMu.Lock()
	defer defaultRuntimeMu.Unlock()
	if defaultRuntime != nil {
		return
	}

	env := newEnvironment(nil)
	secretHome, err := resolveSecretHome(env, "")
	if err != nil {
		return
	}

	if serialized, ok := env.Get(GraphEnvVar); ok && serialized != "" {
		runtime, err := newRuntimeFromGraph([]byte(serialized), env, secretHome, nil)
		if err == nil {
			defaultRuntime = runtime
		}
		return
	}

	if serialized, ok := env.Get(ProjectionEnvVar); ok && serialized != "" {
		runtime, err := newRuntime([]byte(serialized), env, secretHome, nil)
		if err == nil {
			defaultRuntime = runtime
		}
		return
	}

	projectionPath, err := findProjectionPath("")
	if err != nil || projectionPath == "" {
		return
	}

	source, err := os.ReadFile(filepath.Clean(projectionPath))
	if err != nil {
		return
	}
	runtime, err := newRuntime(source, env, secretHome, nil)
	if err == nil {
		defaultRuntime = runtime
	}
}

func resetDefaultRuntime() {
	defaultRuntimeMu.Lock()
	defer defaultRuntimeMu.Unlock()
	defaultRuntime = nil
}
