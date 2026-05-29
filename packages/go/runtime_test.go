package cnos

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	goruntime "runtime"
	"testing"
)

func TestLoadProjectionReadsTemplateDerivedValuesAndCustomRuntimeProviders(t *testing.T) {
	t.Parallel()

	env := map[string]string{
		"PORT": "4500",
	}
	projection := ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "stage",
		ResolvedAt: "2026-05-29T00:00:00Z",
		ConfigHash: "hash",
		Values: map[string]any{
			"app.defaultHost":    "api.kitsy.ai",
			"flags.auth.enabled": true,
		},
		Derived: map[string]DerivedFormula{
			"app.origin": {
				Expr:        "https://${value.app.defaultHost}:${process.env.PORT}",
				Deps:        []string{"value.app.defaultHost"},
				RuntimeRefs: []string{"process.env.PORT"},
			},
			"app.currentHost": {
				Expr:        "coalesce(request.headers.host, value.app.defaultHost)",
				Deps:        []string{"value.app.defaultHost"},
				RuntimeRefs: []string{"request.headers.host"},
			},
		},
		SecretRefs:        map[string]SecretReference{},
		PublicKeys:        []string{"app.defaultHost"},
		RuntimeNamespaces: []string{"process", "request"},
		Meta: ProjectionMeta{
			Workspace:   "api",
			Profile:     "stage",
			CnosVersion: "1.10.0",
			Namespaces:  []string{"flags"},
		},
	}

	runtime := mustLoadProjectionRuntime(t, projection, Options{Environment: env})

	origin, ok, err := runtime.Value("app.origin")
	if err != nil {
		t.Fatalf("read derived origin: %v", err)
	}
	if !ok || origin != "https://api.kitsy.ai:4500" {
		t.Fatalf("expected live origin, got ok=%v value=%v", ok, origin)
	}

	env["PORT"] = "4700"
	origin, ok, err = runtime.Value("app.origin")
	if err != nil {
		t.Fatalf("re-read derived origin: %v", err)
	}
	if !ok || origin != "https://api.kitsy.ai:4700" {
		t.Fatalf("expected updated origin, got ok=%v value=%v", ok, origin)
	}

	host := ""
	if err := runtime.RegisterRuntimeProvider("request", func(path string) any {
		if path == "headers.host" && host != "" {
			return host
		}
		return nil
	}); err != nil {
		t.Fatalf("register request provider: %v", err)
	}

	currentHost, ok, err := runtime.Value("app.currentHost")
	if err != nil {
		t.Fatalf("read request-derived value: %v", err)
	}
	if !ok || currentHost != "api.kitsy.ai" {
		t.Fatalf("expected fallback host, got ok=%v value=%v", ok, currentHost)
	}

	host = "console.kitsy.local"
	currentHost, ok, err = runtime.Value("app.currentHost")
	if err != nil {
		t.Fatalf("re-read request-derived value: %v", err)
	}
	if !ok || currentHost != "console.kitsy.local" {
		t.Fatalf("expected live request host, got ok=%v value=%v", ok, currentHost)
	}

	flag, ok, err := runtime.Read("flags.auth.enabled")
	if err != nil {
		t.Fatalf("read custom namespace value: %v", err)
	}
	if !ok || flag != true {
		t.Fatalf("expected explicit namespace key, got ok=%v value=%v", ok, flag)
	}

	publicValue, ok, err := runtime.Public("app.defaultHost")
	if err != nil {
		t.Fatalf("read public alias: %v", err)
	}
	if !ok || publicValue != "api.kitsy.ai" {
		t.Fatalf("expected public alias to resolve, got ok=%v value=%v", ok, publicValue)
	}

	workspace, ok, err := runtime.Meta("workspace")
	if err != nil {
		t.Fatalf("read meta.workspace: %v", err)
	}
	if !ok || workspace != "api" {
		t.Fatalf("expected meta.workspace, got ok=%v value=%v", ok, workspace)
	}
}

func TestLoadAutodiscoversProjectionFile(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	child := filepath.Join(root, "apps", "api")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("mkdir child: %v", err)
	}

	projection := ServerProjection{
		Version:           1,
		Workspace:         "api",
		Profile:           "local",
		ResolvedAt:        "2026-05-29T00:00:00Z",
		ConfigHash:        "hash",
		Values:            map[string]any{"app.name": "cnos-go"},
		Derived:           map[string]DerivedFormula{},
		SecretRefs:        map[string]SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "local", CnosVersion: "1.10.0"},
	}

	if err := os.WriteFile(filepath.Join(root, ".cnosrc.yml"), []byte("root: ../../.cnos\nworkspace: api\n"), 0o644); err != nil {
		t.Fatalf("write .cnosrc.yml: %v", err)
	}
	writeProjectionFile(t, filepath.Join(root, ".cnos-server.json"), projection)

	runtime, err := Load(Options{
		WorkingDir:  child,
		Environment: map[string]string{},
		SecretHome:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load autodiscovered projection: %v", err)
	}

	name, ok, err := runtime.Value("app.name")
	if err != nil {
		t.Fatalf("read discovered value: %v", err)
	}
	if !ok || name != "cnos-go" {
		t.Fatalf("expected discovered value, got ok=%v value=%v", ok, name)
	}
}

func TestLoadUsesProjectionPathRelativeToWorkingDir(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	child := filepath.Join(root, "deploy")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("mkdir child: %v", err)
	}

	writeProjectionFile(t, filepath.Join(child, ".cnos-server.json"), ServerProjection{
		Version:           1,
		Workspace:         "api",
		Profile:           "prod",
		ResolvedAt:        "2026-05-29T00:00:00Z",
		ConfigHash:        "hash",
		Values:            map[string]any{"app.name": "relative-path"},
		Derived:           map[string]DerivedFormula{},
		SecretRefs:        map[string]SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "prod", CnosVersion: "1.10.0"},
	})

	runtime, err := Load(Options{
		ProjectionPath: ".cnos-server.json",
		WorkingDir:     child,
		Environment:    map[string]string{},
		SecretHome:     t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load relative projection path: %v", err)
	}

	name, ok, err := runtime.Value("app.name")
	if err != nil {
		t.Fatalf("read relative-path value: %v", err)
	}
	if !ok || name != "relative-path" {
		t.Fatalf("expected relative-path value, got ok=%v value=%v", ok, name)
	}
}

func TestLoadReturnsProjectionNotFound(t *testing.T) {
	t.Parallel()

	_, err := Load(Options{
		WorkingDir:  t.TempDir(),
		Environment: map[string]string{},
		SecretHome:  t.TempDir(),
	})
	if !errors.Is(err, ErrProjectionNotFound) {
		t.Fatalf("expected ErrProjectionNotFound, got %v", err)
	}
}

func TestLoadProjectionUsesNodeStyleProcessRuntimeAndStrictEquality(t *testing.T) {
	t.Parallel()

	projection := ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "stage",
		ResolvedAt: "2026-05-29T00:00:00Z",
		ConfigHash: "hash",
		Values: map[string]any{
			"app.name": "cnos-go",
			"data.left": map[string]any{
				"enabled": true,
			},
			"data.right": map[string]any{
				"enabled": true,
			},
		},
		Derived: map[string]DerivedFormula{
			"app.platform": {
				Expr:        "process.platform",
				Deps:        []string{},
				RuntimeRefs: []string{"process.platform"},
			},
			"app.arch": {
				Expr:        "process.arch",
				Deps:        []string{},
				RuntimeRefs: []string{"process.arch"},
			},
			"app.objectsEqual": {
				Expr:        "eq(data.left, data.right)",
				Deps:        []string{"data.left", "data.right"},
				RuntimeRefs: []string{},
			},
		},
		SecretRefs:        map[string]SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{"process"},
		Meta: ProjectionMeta{
			Workspace:   "api",
			Profile:     "stage",
			CnosVersion: "1.10.0",
			Namespaces:  []string{"data"},
		},
	}

	runtime := mustLoadProjectionRuntime(t, projection, Options{Environment: map[string]string{}})

	platform, ok, err := runtime.Value("app.platform")
	if err != nil {
		t.Fatalf("read process.platform derived value: %v", err)
	}
	if !ok || platform != expectedNodePlatform() {
		t.Fatalf("expected Node-style platform, got ok=%v value=%v", ok, platform)
	}

	arch, ok, err := runtime.Value("app.arch")
	if err != nil {
		t.Fatalf("read process.arch derived value: %v", err)
	}
	if !ok || arch != expectedNodeArch() {
		t.Fatalf("expected Node-style arch, got ok=%v value=%v", ok, arch)
	}

	objectsEqual, ok, err := runtime.Value("app.objectsEqual")
	if err != nil {
		t.Fatalf("read strict equality derived value: %v", err)
	}
	if !ok || objectsEqual != false {
		t.Fatalf("expected object equality to follow JS strict semantics, got ok=%v value=%v", ok, objectsEqual)
	}
}

func TestLoadPrefersGraphBootstrapAndSupportsInspect(t *testing.T) {
	t.Parallel()

	graphPayload, err := json.Marshal(RuntimeGraph{
		Profile:       "stage",
		ResolvedAt:    "2026-05-29T00:00:00Z",
		ProfileSource: "workspace-file",
		Workspace: GraphWorkspace{
			WorkspaceID:     "api",
			WorkspaceSource: "anchor-file",
			WorkspaceChain:  []string{"base", "api"},
			WorkspaceRoots:  []GraphWorkspaceRoot{},
		},
		Entries: []GraphResolvedEntry{
			{
				Key:       "value.app.host",
				Namespace: "value",
				Value:     "graph.kitsy.ai",
				Winner: GraphConfigEntry{
					Key:         "value.app.host",
					Namespace:   "value",
					Value:       "graph.kitsy.ai",
					SourceID:    "filesystem-values",
					PluginID:    "filesystem-values",
					WorkspaceID: "api",
					Origin:      &ConfigOrigin{File: "/config/workspaces/api/values/stage/app.yml"},
				},
				Overridden: []GraphConfigEntry{
					{
						Key:         "value.app.host",
						Namespace:   "value",
						Value:       "base.kitsy.ai",
						SourceID:    "filesystem-values",
						PluginID:    "filesystem-values",
						WorkspaceID: "base",
						Origin:      &ConfigOrigin{File: "/config/workspaces/base/values/base/app.yml"},
					},
				},
			},
			{
				Key:       "value.app.currentHost",
				Namespace: "value",
				Value: map[string]any{
					"$derive": map[string]any{
						"expr": "coalesce(request.headers.host, value.app.host)",
					},
				},
				Winner: GraphConfigEntry{
					Key:       "value.app.currentHost",
					Namespace: "value",
					Value: map[string]any{
						"$derive": map[string]any{
							"expr": "coalesce(request.headers.host, value.app.host)",
						},
					},
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
		t.Fatalf("marshal runtime graph: %v", err)
	}

	projectionPayload, err := json.Marshal(ServerProjection{
		Version:           1,
		Workspace:         "api",
		Profile:           "prod",
		ResolvedAt:        "2026-05-29T00:00:00Z",
		ConfigHash:        "hash",
		Values:            map[string]any{"app.host": "projection.kitsy.ai"},
		Derived:           map[string]DerivedFormula{},
		SecretRefs:        map[string]SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "prod", CnosVersion: "1.10.0"},
	})
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}

	runtime, err := Load(Options{
		Environment: map[string]string{
			GraphEnvVar:      string(graphPayload),
			ProjectionEnvVar: string(projectionPayload),
		},
		SecretHome: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load graph bootstrap: %v", err)
	}

	host, ok, err := runtime.Value("app.host")
	if err != nil {
		t.Fatalf("read graph bootstrapped host: %v", err)
	}
	if !ok || host != "graph.kitsy.ai" {
		t.Fatalf("expected graph bootstrap to win, got ok=%v value=%v", ok, host)
	}

	hostInspect, err := runtime.Inspect("value.app.host")
	if err != nil {
		t.Fatalf("inspect graph bootstrapped host: %v", err)
	}
	if hostInspect.ProfileSource != "workspace-file" || hostInspect.Workspace.Source != "anchor-file" {
		t.Fatalf("expected graph profile/workspace provenance, got %#v", hostInspect)
	}
	if len(hostInspect.Overridden) != 1 || hostInspect.Overridden[0].Value != "base.kitsy.ai" {
		t.Fatalf("expected graph override provenance, got %#v", hostInspect.Overridden)
	}

	if err := runtime.RegisterRuntimeProvider("request", func(path string) any {
		if path == "headers.host" {
			return "console.kitsy.local"
		}
		return nil
	}); err != nil {
		t.Fatalf("register request provider on graph bootstrap: %v", err)
	}

	currentHost, ok, err := runtime.Value("app.currentHost")
	if err != nil {
		t.Fatalf("read graph-derived currentHost: %v", err)
	}
	if !ok || currentHost != "console.kitsy.local" {
		t.Fatalf("expected live graph-derived value, got ok=%v value=%v", ok, currentHost)
	}

	currentHostInspect, err := runtime.Inspect("value.app.currentHost")
	if err != nil {
		t.Fatalf("inspect graph-derived currentHost: %v", err)
	}
	if currentHostInspect.Derived == nil || len(currentHostInspect.Derived.RuntimeNamespaces) != 1 || currentHostInspect.Derived.RuntimeNamespaces[0] != "request" {
		t.Fatalf("expected graph-derived inspect runtime namespaces, got %#v", currentHostInspect.Derived)
	}

	if _, err := runtime.ToServerProjection(); err == nil {
		t.Fatalf("expected graph bootstrap to reject server projection export")
	}
}

func mustLoadProjectionRuntime(t *testing.T, projection ServerProjection, options Options) *Runtime {
	t.Helper()

	payload, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}

	runtime, err := LoadProjection(payload, options)
	if err != nil {
		t.Fatalf("load projection: %v", err)
	}
	return runtime
}

func writeProjectionFile(t *testing.T, path string, projection ServerProjection) {
	t.Helper()

	payload, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		t.Fatalf("write projection file: %v", err)
	}
}

func expectedNodePlatform() string {
	switch goruntime.GOOS {
	case "windows":
		return "win32"
	default:
		return goruntime.GOOS
	}
}

func expectedNodeArch() string {
	switch goruntime.GOARCH {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	default:
		return goruntime.GOARCH
	}
}
