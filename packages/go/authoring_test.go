package cnos

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAuthoringResolvesFilesystemDotenvProcessEnvAndPublicPromotion(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeAuthoringFile(t, filepath.Join(root, "cnos", "cnos.yml"), []byte(`
version: 1
project:
  name: cnos-go
profiles:
  default: local
envMapping:
  explicit:
    SERVER_PORT: value.server.port
    UPLOAD_BYTES: value.app.uploadBytes
public:
  promote:
    - value.app.host
namespaces:
  runtime:
    request:
      description: Request-scoped runtime data
vaults:
  default:
    provider: environment
    mapping:
      APP_TOKEN: app.token
schema:
  value.server.port:
    type: number
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "values", "base", "app.yml"), []byte(`
server:
  port: 3000
app:
  host: base.kitsy.ai
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "values", "local", "app.yml"), []byte(`
server:
  port: 4000
app:
  host: local.kitsy.ai
  uploadBytes: 10485760
  origin:
    $derive: "https://${value.app.host}:${process.env.PORT}"
  uploadLabel:
    $derive: "upload-${value.app.uploadBytes}"
  currentHost:
    $derive:
      expr: "coalesce(request.headers.host, value.app.host)"
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "secrets", "local", "app.yml"), []byte(`
app:
  token:
    provider: environment
    vault: default
    ref: app.token
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "env", ".env"), []byte("SERVER_PORT=5000\n"))

	env := map[string]string{
		"SERVER_PORT": "6000",
		"PORT":        "7010",
		"APP_TOKEN":   "process-secret",
	}

	runtime, err := Load(Options{
		Root:        root,
		Environment: env,
		SecretHome:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load authoring runtime: %v", err)
	}

	port, ok, err := runtime.Value("server.port")
	if err != nil {
		t.Fatalf("read value.server.port: %v", err)
	}
	if !ok || port != float64(6000) {
		t.Fatalf("expected schema-coerced process env port, got ok=%v value=%v", ok, port)
	}

	publicHost, ok, err := runtime.Public("app.host")
	if err != nil {
		t.Fatalf("read public.app.host: %v", err)
	}
	if !ok || publicHost != "local.kitsy.ai" {
		t.Fatalf("expected promoted public host, got ok=%v value=%v", ok, publicHost)
	}

	origin, ok, err := runtime.Value("app.origin")
	if err != nil {
		t.Fatalf("read derived origin: %v", err)
	}
	if !ok || origin != "https://local.kitsy.ai:7010" {
		t.Fatalf("expected live origin, got ok=%v value=%v", ok, origin)
	}

	currentHost, ok, err := runtime.Value("app.currentHost")
	if err != nil {
		t.Fatalf("read fallback currentHost: %v", err)
	}
	if !ok || currentHost != "local.kitsy.ai" {
		t.Fatalf("expected fallback currentHost, got ok=%v value=%v", ok, currentHost)
	}

	hostInspect, err := runtime.Inspect("value.app.host")
	if err != nil {
		t.Fatalf("inspect value.app.host: %v", err)
	}
	if hostInspect.Winner.SourceID != "filesystem-values" || hostInspect.Winner.PluginID != "filesystem-values" {
		t.Fatalf("expected filesystem-values winner, got %#v", hostInspect.Winner)
	}
	if hostInspect.Winner.Origin == nil || hostInspect.Winner.Origin.File != filepath.Join(root, "cnos", "values", "local", "app.yml") {
		t.Fatalf("expected winning origin file, got %#v", hostInspect.Winner.Origin)
	}
	if len(hostInspect.Overridden) != 1 || hostInspect.Overridden[0].Value != "base.kitsy.ai" {
		t.Fatalf("expected base override provenance, got %#v", hostInspect.Overridden)
	}

	currentHostInspect, err := runtime.Inspect("value.app.currentHost")
	if err != nil {
		t.Fatalf("inspect value.app.currentHost: %v", err)
	}
	if currentHostInspect.Derived == nil || !currentHostInspect.Derived.RuntimeDependent {
		t.Fatalf("expected runtime-dependent derived inspect data, got %#v", currentHostInspect.Derived)
	}
	if currentHostInspect.Derived.Expression != "coalesce(request.headers.host, value.app.host)" {
		t.Fatalf("unexpected derived expression: %#v", currentHostInspect.Derived)
	}
	if len(currentHostInspect.Derived.Dependencies) != 2 || currentHostInspect.Derived.Dependencies[0].RuntimeNamespace != "request" {
		t.Fatalf("expected derived dependency details, got %#v", currentHostInspect.Derived.Dependencies)
	}

	requestHost := ""
	if err := runtime.RegisterRuntimeProvider("request", func(path string) any {
		if path == "headers.host" && requestHost != "" {
			return requestHost
		}
		return nil
	}); err != nil {
		t.Fatalf("register request provider: %v", err)
	}

	requestHost = "console.kitsy.local"
	currentHost, ok, err = runtime.Value("app.currentHost")
	if err != nil {
		t.Fatalf("read request currentHost: %v", err)
	}
	if !ok || currentHost != "console.kitsy.local" {
		t.Fatalf("expected request currentHost, got ok=%v value=%v", ok, currentHost)
	}

	env["PORT"] = "7020"
	origin, ok, err = runtime.Value("app.origin")
	if err != nil {
		t.Fatalf("re-read derived origin: %v", err)
	}
	if !ok || origin != "https://local.kitsy.ai:7020" {
		t.Fatalf("expected refreshed origin, got ok=%v value=%v", ok, origin)
	}

	token, ok, err := runtime.Secret("app.token")
	if err != nil {
		t.Fatalf("read mapped environment secret: %v", err)
	}
	if !ok || token != "process-secret" {
		t.Fatalf("expected mapped environment secret, got ok=%v value=%v", ok, token)
	}

	envOutput, err := runtime.ToEnv()
	if err != nil {
		t.Fatalf("build env output: %v", err)
	}
	if value := envOutput["SERVER_PORT"]; value != "6000" {
		t.Fatalf("expected SERVER_PORT export, got %q", value)
	}
	if value := envOutput["UPLOAD_BYTES"]; value != "10485760" {
		t.Fatalf("expected UPLOAD_BYTES export, got %q", value)
	}

	publicEnv, err := runtime.ToPublicEnv(ToPublicEnvOptions{Framework: "vite"})
	if err != nil {
		t.Fatalf("build public env output: %v", err)
	}
	if value := publicEnv["VITE_APP_HOST"]; value != "local.kitsy.ai" {
		t.Fatalf("expected VITE_APP_HOST export, got %q", value)
	}

	valueNamespace, err := runtime.ToNamespace("value")
	if err != nil {
		t.Fatalf("build value namespace object: %v", err)
	}
	appValue, ok := valueNamespace["app"].(map[string]any)
	if !ok || appValue["host"] != "local.kitsy.ai" {
		t.Fatalf("expected nested value namespace output, got %#v", valueNamespace)
	}

	uploadLabel, ok, err := runtime.Value("app.uploadLabel")
	if err != nil {
		t.Fatalf("read upload label: %v", err)
	}
	if !ok || uploadLabel != "upload-10485760" {
		t.Fatalf("expected decimal upload label, got ok=%v value=%v", ok, uploadLabel)
	}

	fullObject, err := runtime.ToObject()
	if err != nil {
		t.Fatalf("build full object: %v", err)
	}
	metaValue, ok := fullObject["meta"].(map[string]any)
	if !ok || metaValue["profile"] != "local" {
		t.Fatalf("expected meta namespace in full object, got %#v", fullObject)
	}

	projection, err := runtime.ToServerProjection()
	if err != nil {
		t.Fatalf("build server projection: %v", err)
	}
	if projection.Values["app.host"] != "local.kitsy.ai" {
		t.Fatalf("expected app.host in server projection, got %#v", projection.Values)
	}
	if _, ok := projection.Derived["app.origin"]; !ok {
		t.Fatalf("expected derived app.origin in server projection, got %#v", projection.Derived)
	}

	formatted, err := runtime.Format("upload=${value.app.uploadBytes}")
	if err != nil {
		t.Fatalf("format upload bytes: %v", err)
	}
	if formatted != "upload=10485760" {
		t.Fatalf("expected decimal formatted upload bytes, got %q", formatted)
	}
}

func TestLoadAuthoringUsesAnchorWorkspaceAndWorkspaceFileProfile(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	consumerRoot := filepath.Join(root, "apps", "api")
	workingDir := filepath.Join(consumerRoot, "cmd")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir working dir: %v", err)
	}

	writeAuthoringFile(t, filepath.Join(root, "cnos", "cnos.yml"), []byte(`
version: 1
project:
  name: cnos-go
profiles:
  default: local
workspaces:
  items:
    base: {}
    api:
      extends:
        - base
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "workspaces", "base", "values", "base", "app.yml"), []byte(`
app:
  host: base.kitsy.ai
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "workspaces", "api", "values", "stage", "app.yml"), []byte(`
app:
  host: stage.kitsy.ai
`))
	writeAuthoringFile(t, filepath.Join(consumerRoot, ".cnosrc.yml"), []byte("root: ../../cnos\nworkspace: api\n"))
	writeAuthoringFile(t, filepath.Join(consumerRoot, ".cnos-workspace.yml"), []byte("profile: stage\n"))

	runtime, err := Load(Options{
		WorkingDir:  workingDir,
		Environment: map[string]string{"CNOS_PROFILE": "prod"},
		SecretHome:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load authoring runtime from anchor: %v", err)
	}

	workspace, ok, err := runtime.Meta("workspace")
	if err != nil {
		t.Fatalf("read meta.workspace: %v", err)
	}
	if !ok || workspace != "api" {
		t.Fatalf("expected anchored workspace, got ok=%v value=%v", ok, workspace)
	}

	profile, ok, err := runtime.Meta("profile")
	if err != nil {
		t.Fatalf("read meta.profile: %v", err)
	}
	if !ok || profile != "stage" {
		t.Fatalf("expected workspace-file profile, got ok=%v value=%v", ok, profile)
	}

	resolvedFrom, ok, err := runtime.Meta("resolved.from")
	if err != nil {
		t.Fatalf("read meta.resolved.from: %v", err)
	}
	if !ok || resolvedFrom != "workspace-file" {
		t.Fatalf("expected workspace-file profile source, got ok=%v value=%v", ok, resolvedFrom)
	}

	host, ok, err := runtime.Value("app.host")
	if err != nil {
		t.Fatalf("read stage app.host: %v", err)
	}
	if !ok || host != "stage.kitsy.ai" {
		t.Fatalf("expected stage app.host, got ok=%v value=%v", ok, host)
	}
}

func TestAuthoringProjectionSanitizesVaultAuthConfig(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	writeAuthoringFile(t, filepath.Join(root, "cnos", "cnos.yml"), []byte(`
version: 1
project:
  name: cnos-go-vault-sanitize
profiles:
  default: local
vaults:
  remote-prod:
    provider: test-remote
    auth:
      method: token
      token:
        from:
          - env:TEST_REMOTE_TOKEN
      config:
        address: https://vault.local
        vaultUrl: https://cnos-test.vault.azure.net
        tenantId: tenant-id
        clientId: client-id
        clientSecret: should-not-project
        nested:
          privateKey: should-not-project
          tenant: cnos
    fallback:
      - provider: fallback-remote
        auth:
          method: token
          token:
            from:
              - env:FALLBACK_REMOTE_TOKEN
          config:
            endpoint: https://fallback.local
            vaultUrl: https://fallback.vault.azure.net
            tenantId: fallback-tenant
            clientId: fallback-client
            authorization: bearer should-not-project
            nested:
              privateKey: should-not-project
              tenant: fallback
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "secrets", "local", "db.yml"), []byte(`
db:
  password:
    vault: remote-prod
    ref: db.password
`))

	runtime, err := Load(Options{
		Root:        root,
		Environment: map[string]string{},
		SecretHome:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load authoring runtime: %v", err)
	}

	projection, err := runtime.ToServerProjection()
	if err != nil {
		t.Fatalf("build server projection: %v", err)
	}

	projected := projection.Vaults["remote-prod"]
	if projected.Auth.Config["clientSecret"] != nil {
		t.Fatalf("expected clientSecret to be stripped, got %#v", projected.Auth.Config)
	}
	nested, ok := projected.Auth.Config["nested"].(map[string]any)
	if !ok || nested["tenant"] != "cnos" || nested["privateKey"] != nil {
		t.Fatalf("expected sanitized nested config, got %#v", projected.Auth.Config)
	}
	if projected.Auth.Config["address"] != "https://vault.local" {
		t.Fatalf("expected address to be projected, got %#v", projected.Auth.Config)
	}
	if projected.Auth.Config["vaultUrl"] != "https://cnos-test.vault.azure.net" ||
		projected.Auth.Config["tenantId"] != "tenant-id" ||
		projected.Auth.Config["clientId"] != "client-id" {
		t.Fatalf("expected Azure-safe config keys to be projected, got %#v", projected.Auth.Config)
	}
	if len(projected.Fallback) != 1 {
		t.Fatalf("expected one fallback vault, got %#v", projected.Fallback)
	}
	fallback := projected.Fallback[0]
	if fallback.Auth.Config["authorization"] != nil {
		t.Fatalf("expected fallback authorization to be stripped, got %#v", fallback.Auth.Config)
	}
	fallbackNested, ok := fallback.Auth.Config["nested"].(map[string]any)
	if !ok || fallbackNested["tenant"] != "fallback" || fallbackNested["privateKey"] != nil {
		t.Fatalf("expected sanitized fallback nested config, got %#v", fallback.Auth.Config)
	}
	if fallback.Auth.Config["endpoint"] != "https://fallback.local" {
		t.Fatalf("expected endpoint to be projected, got %#v", fallback.Auth.Config)
	}
	if fallback.Auth.Config["vaultUrl"] != "https://fallback.vault.azure.net" ||
		fallback.Auth.Config["tenantId"] != "fallback-tenant" ||
		fallback.Auth.Config["clientId"] != "fallback-client" {
		t.Fatalf("expected fallback Azure-safe config keys to be projected, got %#v", fallback.Auth.Config)
	}
}

func TestLoadAuthoringLayersGlobalAndLocalWorkspaceRoots(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	globalRoot := t.TempDir()

	writeAuthoringFile(t, filepath.Join(root, "cnos", "cnos.yml"), []byte(`
version: 1
project:
  name: cnos-go
profiles:
  default: local
workspaces:
  default: api
  global:
    enabled: true
  items:
    base: {}
    api:
      extends:
        - base
`))
	writeAuthoringFile(t, filepath.Join(globalRoot, "workspaces", "base", "values", "base", "app.yml"), []byte(`
server:
  host: global-base
`))
	writeAuthoringFile(t, filepath.Join(globalRoot, "workspaces", "api", "values", "local", "app.yml"), []byte(`
server:
  host: global-api
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "workspaces", "base", "values", "base", "app.yml"), []byte(`
server:
  host: local-base
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "workspaces", "api", "values", "local", "app.yml"), []byte(`
server:
  host: local-api
`))

	runtime, err := Load(Options{
		Root:        root,
		Workspace:   "api",
		GlobalRoot:  globalRoot,
		Environment: map[string]string{},
		SecretHome:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load authoring runtime with global root: %v", err)
	}

	host, ok, err := runtime.Value("server.host")
	if err != nil {
		t.Fatalf("read layered server.host: %v", err)
	}
	if !ok || host != "local-api" {
		t.Fatalf("expected local workspace root to win, got ok=%v value=%v", ok, host)
	}

	globalEnabled, ok, err := runtime.Meta("global.enabled")
	if err != nil {
		t.Fatalf("read meta.global.enabled: %v", err)
	}
	if !ok || globalEnabled != true {
		t.Fatalf("expected meta.global.enabled=true, got ok=%v value=%v", ok, globalEnabled)
	}

	globalRootValue, ok, err := runtime.Meta("globalRoot")
	if err != nil {
		t.Fatalf("read meta.globalRoot: %v", err)
	}
	if err != nil {
		t.Fatalf("resolve absolute global root: %v", err)
	}
	expectedGlobalRoot, err := filepath.Abs(globalRoot)
	if err != nil {
		t.Fatalf("resolve absolute global root: %v", err)
	}
	if !ok || globalRootValue != expectedGlobalRoot {
		t.Fatalf("expected resolved global root, got ok=%v value=%v", ok, globalRootValue)
	}
}

func TestLoadAuthoringHydratesLocalVaultSecretFromSessionFile(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	secretHome := t.TempDir()
	derivedKey := writeLocalVaultFixture(t, secretHome, "default", map[string]string{
		"app.token": "authoring-secret",
	})
	writeVaultSessionFixture(t, secretHome, "default", derivedKey)

	writeAuthoringFile(t, filepath.Join(root, "cnos", "cnos.yml"), []byte(`
version: 1
project:
  name: cnos-go
profiles:
  default: local
vaults:
  default:
    provider: local
`))
	writeAuthoringFile(t, filepath.Join(root, "cnos", "secrets", "local", "app.yml"), []byte(`
app:
  token:
    provider: local
    vault: default
    ref: app.token
`))

	runtime, err := Load(Options{
		Root:        root,
		Environment: map[string]string{},
		SecretHome:  secretHome,
	})
	if err != nil {
		t.Fatalf("load authoring runtime with local vault: %v", err)
	}

	token, ok, err := runtime.Secret("app.token")
	if err != nil {
		t.Fatalf("read authoring local secret: %v", err)
	}
	if !ok || token != "authoring-secret" {
		t.Fatalf("expected authoring local secret, got ok=%v value=%v", ok, token)
	}
}

func writeAuthoringFile(t *testing.T, path string, content []byte) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
