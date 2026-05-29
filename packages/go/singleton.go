package cnos

import (
	"fmt"
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
	defaultRuntimeMu.Lock()
	runtime := defaultRuntime
	defaultRuntimeMu.Unlock()

	if runtime != nil {
		return runtime.warmSecrets()
	}

	loadOptions := Options{}
	if len(options) > 0 {
		loadOptions = options[0]
	}
	loaded, err := Load(loadOptions)
	if err != nil {
		return err
	}
	if err := loaded.warmSecrets(); err != nil {
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

func RefreshSecrets() error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	runtime.RefreshSecrets()
	return runtime.warmSecrets()
}

func RefreshSecret(path string) error {
	runtime, err := DefaultRuntime()
	if err != nil {
		return err
	}
	runtime.RefreshSecret(path)
	return nil
}

func Projection() (ServerProjection, error) {
	runtime, err := DefaultRuntime()
	if err != nil {
		return ServerProjection{}, err
	}
	return runtime.ToServerProjection()
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
		runtime, err := newRuntimeFromGraph([]byte(serialized), env, secretHome)
		if err == nil {
			defaultRuntime = runtime
		}
		return
	}

	if serialized, ok := env.Get(ProjectionEnvVar); ok && serialized != "" {
		runtime, err := newRuntime([]byte(serialized), env, secretHome)
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
	runtime, err := newRuntime(source, env, secretHome)
	if err == nil {
		defaultRuntime = runtime
	}
}

func resetDefaultRuntime() {
	defaultRuntimeMu.Lock()
	defer defaultRuntimeMu.Unlock()
	defaultRuntime = nil
}
