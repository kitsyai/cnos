package cnos

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSingletonReadyLoadsAuthoringRuntimeAndExportsHelpers(t *testing.T) {
	originalCwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	root := t.TempDir()
	t.Cleanup(func() {
		_ = os.Chdir(originalCwd)
		resetDefaultRuntime()
	})

	resetDefaultRuntime()
	if _, _, err := Read("value.server.port"); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("expected ErrRuntimeNotReady before Ready, got %v", err)
	}

	writeAuthoringFile(t, filepath.Join(root, ".cnosrc.yml"), []byte("root: ./.cnos\n"))
	writeAuthoringFile(t, filepath.Join(root, ".cnos", "cnos.yml"), []byte(`
version: 1
project:
  name: runtime-fixture
envMapping:
  explicit:
    PORT: value.server.port
public:
  promote:
    - value.app.name
namespaces:
  runtime:
    request:
      description: Request context
`))
	writeAuthoringFile(t, filepath.Join(root, ".cnos", "values", "app.yml"), []byte(`
server:
  port: 3000
app:
  name: cnos-go
  effectivePort:
    $derive:
      expr: "coalesce(process.env.PORT, value.server.port, '3000')"
  currentHost:
    $derive:
      expr: "coalesce(request.headers.host, 'kitsy.local')"
`))
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir root: %v", err)
	}

	t.Setenv("PORT", "4500")
	if err := Ready(); err != nil {
		t.Fatalf("ready authoring singleton: %v", err)
	}

	port, ok, err := Read("value.server.port")
	if err != nil {
		t.Fatalf("read server.port: %v", err)
	}
	if !ok || port != "4500" {
		t.Fatalf("expected server.port, got ok=%v value=%v", ok, port)
	}

	effectivePort, ok, err := Value("app.effectivePort")
	if err != nil {
		t.Fatalf("read effective port: %v", err)
	}
	if !ok || effectivePort != "4500" {
		t.Fatalf("expected derived effective port, got ok=%v value=%v", ok, effectivePort)
	}

	if err := RegisterRuntimeProvider("request", func(path string) any {
		if path == "headers.host" {
			return "console.kitsy.local"
		}
		return nil
	}); err != nil {
		t.Fatalf("register request provider: %v", err)
	}

	host, ok, err := Value("app.currentHost")
	if err != nil {
		t.Fatalf("read current host: %v", err)
	}
	if !ok || host != "console.kitsy.local" {
		t.Fatalf("expected request-derived host, got ok=%v value=%v", ok, host)
	}

	envOutput, err := ToEnv()
	if err != nil {
		t.Fatalf("build env output: %v", err)
	}
	if envOutput["PORT"] != "4500" {
		t.Fatalf("expected PORT env export, got %#v", envOutput)
	}

	publicEnv, err := ToPublicEnv(ToPublicEnvOptions{Framework: "vite"})
	if err != nil {
		t.Fatalf("build public env output: %v", err)
	}
	if publicEnv["VITE_APP_NAME"] != "cnos-go" {
		t.Fatalf("expected VITE_APP_NAME export, got %#v", publicEnv)
	}

	valueNamespace, err := ToNamespace("value")
	if err != nil {
		t.Fatalf("build value namespace: %v", err)
	}
	serverValue, ok := valueNamespace["server"].(map[string]any)
	if !ok || serverValue["port"] != "4500" {
		t.Fatalf("expected nested namespace export, got %#v", valueNamespace)
	}

	formatted, err := Format("Starting server at ${value.server.port}")
	if err != nil {
		t.Fatalf("format runtime message: %v", err)
	}
	if formatted != "Starting server at 4500" {
		t.Fatalf("expected formatted message, got %q", formatted)
	}
}

func TestSingletonBootstrapsFromProjectionEnv(t *testing.T) {
	resetDefaultRuntime()
	t.Cleanup(resetDefaultRuntime)

	projection := ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "base",
		ResolvedAt: "2026-05-29T00:00:00Z",
		ConfigHash: "hash",
		Values: map[string]any{
			"server.port": 3000,
		},
		Derived: map[string]DerivedFormula{
			"app.effectivePort": {
				Expr:        "coalesce(process.env.PORT, value.server.port, '3000')",
				Deps:        []string{"value.server.port"},
				RuntimeRefs: []string{"process.env.PORT"},
			},
		},
		SecretRefs:        map[string]SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{"process"},
		Meta: ProjectionMeta{
			Workspace:   "api",
			Profile:     "base",
			CnosVersion: "1.10.0",
		},
	}

	payload, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}

	t.Setenv(ProjectionEnvVar, string(payload))
	t.Setenv("PORT", "4700")
	bootstrapDefaultRuntime()

	port, ok, err := Value("app.effectivePort")
	if err != nil {
		t.Fatalf("read projection-derived effective port: %v", err)
	}
	if !ok || port != "4700" {
		t.Fatalf("expected projection bootstrap value, got ok=%v value=%v", ok, port)
	}
}

func TestSingletonBootstrapsFromGraphEnvAndExposesInspect(t *testing.T) {
	resetDefaultRuntime()
	t.Cleanup(resetDefaultRuntime)

	payload, err := json.Marshal(RuntimeGraph{
		Profile:       "stage",
		ResolvedAt:    "2026-05-29T00:00:00Z",
		ProfileSource: "env",
		Workspace: GraphWorkspace{
			WorkspaceID:     "api",
			WorkspaceSource: "anchor-file",
			WorkspaceChain:  []string{"api"},
			WorkspaceRoots:  []GraphWorkspaceRoot{},
		},
		Entries: []GraphResolvedEntry{
			{
				Key:       "value.server.port",
				Namespace: "value",
				Value:     3100,
				Winner: GraphConfigEntry{
					Key:         "value.server.port",
					Namespace:   "value",
					Value:       3100,
					SourceID:    "filesystem-values",
					PluginID:    "filesystem-values",
					WorkspaceID: "api",
				},
				Overridden: []GraphConfigEntry{},
			},
			{
				Key:       "meta.profile",
				Namespace: "meta",
				Value:     "stage",
				Winner: GraphConfigEntry{
					Key:         "meta.profile",
					Namespace:   "meta",
					Value:       "stage",
					SourceID:    "cnos-runtime",
					PluginID:    "cnos",
					WorkspaceID: "api",
				},
				Overridden: []GraphConfigEntry{},
			},
			{
				Key:       "meta.workspace",
				Namespace: "meta",
				Value:     "api",
				Winner: GraphConfigEntry{
					Key:         "meta.workspace",
					Namespace:   "meta",
					Value:       "api",
					SourceID:    "cnos-runtime",
					PluginID:    "cnos",
					WorkspaceID: "api",
				},
				Overridden: []GraphConfigEntry{},
			},
			{
				Key:       "meta.cnos_version",
				Namespace: "meta",
				Value:     "1.10.0",
				Winner: GraphConfigEntry{
					Key:         "meta.cnos_version",
					Namespace:   "meta",
					Value:       "1.10.0",
					SourceID:    "cnos-runtime",
					PluginID:    "cnos",
					WorkspaceID: "api",
				},
				Overridden: []GraphConfigEntry{},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal graph payload: %v", err)
	}

	t.Setenv(GraphEnvVar, string(payload))
	bootstrapDefaultRuntime()

	port, ok, err := Read("value.server.port")
	if err != nil {
		t.Fatalf("read graph bootstrapped value: %v", err)
	}
	if !ok || port != float64(3100) {
		t.Fatalf("expected graph bootstrapped port, got ok=%v value=%v", ok, port)
	}

	inspect, err := Inspect("value.server.port")
	if err != nil {
		t.Fatalf("inspect graph bootstrapped value: %v", err)
	}
	if inspect.Profile != "stage" || inspect.Workspace.ID != "api" {
		t.Fatalf("expected graph inspect context, got %#v", inspect)
	}
}
