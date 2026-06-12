package cnos

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fakeSecretVaultProvider struct {
	authCalls  *[]VaultAuthConfig
	batchCalls *[][]string
	getCalls   *[]string
	values     map[string]any
}

func (provider *fakeSecretVaultProvider) Authenticate(auth VaultAuthConfig) error {
	*provider.authCalls = append(*provider.authCalls, auth)
	return nil
}

func (provider *fakeSecretVaultProvider) BatchGet(refs []string) (map[string]any, error) {
	*provider.batchCalls = append(*provider.batchCalls, append([]string(nil), refs...))
	result := map[string]any{}
	for _, ref := range refs {
		result[ref] = provider.values[ref]
	}
	return result, nil
}

func (provider *fakeSecretVaultProvider) Get(ref string) (any, error) {
	*provider.getCalls = append(*provider.getCalls, ref)
	return provider.values[ref], nil
}

func TestLoadProjectionHydratesCustomVaultProviderInSingleBatch(t *testing.T) {
	t.Parallel()

	authCalls := []VaultAuthConfig{}
	batchCalls := [][]string{}
	getCalls := []string{}
	var capturedDefinition VaultDefinition
	factory := SecretVaultProviderFactory{
		Provider: "test-remote",
		Create: func(vaultID string, definition VaultDefinition) (SecretVaultProvider, error) {
			if vaultID != "remote-prod" {
				t.Fatalf("expected remote-prod vault, got %q", vaultID)
			}
			capturedDefinition = definition
			return &fakeSecretVaultProvider{
				authCalls:  &authCalls,
				batchCalls: &batchCalls,
				getCalls:   &getCalls,
				values: map[string]any{
					"db.password": "remote-password",
					"api.token":   "remote-token",
				},
			}, nil
		},
	}

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "prod",
		ResolvedAt: "2026-06-11T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"db.password": {Vault: "remote-prod", Ref: "db.password"},
			"api.token":   {Vault: "remote-prod", Ref: "api.token"},
		},
		Vaults: map[string]vaultDefinition{
			"remote-prod": {
				Provider: "test-remote",
				Auth: vaultAuthFile{
					Method: "token",
					Token:  &vaultAuthSourceFile{From: []string{"env:REMOTE_TOKEN"}},
					Config: map[string]any{"address": "https://vault.local"},
				},
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "prod", CnosVersion: "1.10.0"},
	}, Options{
		Environment: map[string]string{"REMOTE_TOKEN": "provider-token"},
		SecretHome:  t.TempDir(),
		SecretVaultProviders: []SecretVaultProviderFactory{
			factory,
		},
	})

	if err := runtime.warmSecrets(); err != nil {
		t.Fatalf("warm secrets: %v", err)
	}
	if len(batchCalls) != 1 || !reflect.DeepEqual(batchCalls[0], []string{"api.token", "db.password"}) {
		t.Fatalf("expected one sorted batch call, got %#v", batchCalls)
	}
	if len(getCalls) != 0 {
		t.Fatalf("expected no per-ref get calls, got %#v", getCalls)
	}
	if len(authCalls) != 1 || authCalls[0].Method != "token" || authCalls[0].Token != "provider-token" {
		t.Fatalf("expected token auth, got %#v", authCalls)
	}
	if capturedDefinition.Provider != "test-remote" || capturedDefinition.Auth.Config["address"] != "https://vault.local" {
		t.Fatalf("expected projected vault definition, got %#v", capturedDefinition)
	}

	password, ok, err := runtime.Secret("db.password")
	if err != nil {
		t.Fatalf("read db password: %v", err)
	}
	token, tokenOK, err := runtime.Secret("api.token")
	if err != nil {
		t.Fatalf("read api token: %v", err)
	}
	if !ok || password != "remote-password" || !tokenOK || token != "remote-token" {
		t.Fatalf("expected hydrated remote secrets, got password=%v/%v token=%v/%v", password, ok, token, tokenOK)
	}
	if len(batchCalls) != 1 || len(getCalls) != 0 {
		t.Fatalf("expected reads to use cache, got batch=%#v get=%#v", batchCalls, getCalls)
	}
}

func TestLoadProjectionUsesExplicitVaultFallback(t *testing.T) {
	t.Parallel()

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "prod",
		ResolvedAt: "2026-06-11T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"db.password": {Vault: "remote-prod", Ref: "db.password"},
		},
		Vaults: map[string]vaultDefinition{
			"remote-prod": {
				Provider: "test-remote",
				Fallback: []vaultDefinition{
					{
						Provider: "environment",
						Mapping: map[string]string{
							"DB_PASSWORD": "db.password",
						},
					},
				},
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "prod", CnosVersion: "1.10.0"},
	}, Options{
		Environment: map[string]string{"DB_PASSWORD": "fallback-secret"},
		SecretHome:  t.TempDir(),
	})

	password, ok, err := runtime.Secret("db.password")
	if err != nil {
		t.Fatalf("read fallback password: %v", err)
	}
	if !ok || password != "fallback-secret" {
		t.Fatalf("expected fallback secret, got ok=%v value=%v", ok, password)
	}

	exported, err := runtime.ToServerProjection()
	if err != nil {
		t.Fatalf("export projection: %v", err)
	}
	if exported.SecretRefs["db.password"].Provider != "test-remote" {
		t.Fatalf("expected exported secret ref to inherit provider, got %#v", exported.SecretRefs["db.password"])
	}
	if len(exported.Vaults["remote-prod"].Fallback) != 1 || exported.Vaults["remote-prod"].Fallback[0].Provider != "environment" {
		t.Fatalf("expected fallback to round-trip, got %#v", exported.Vaults["remote-prod"])
	}
}

func TestLoadProjectionUsesCustomProviderFallback(t *testing.T) {
	t.Parallel()

	primaryBatchCalls := [][]string{}
	fallbackBatchCalls := [][]string{}
	primaryFactory := SecretVaultProviderFactory{
		Provider: "primary-remote",
		Create: func(_ string, _ VaultDefinition) (SecretVaultProvider, error) {
			return &fakeSecretVaultProvider{
				authCalls:  &[]VaultAuthConfig{},
				batchCalls: &primaryBatchCalls,
				getCalls:   &[]string{},
				values:     map[string]any{},
			}, nil
		},
	}
	fallbackFactory := SecretVaultProviderFactory{
		Provider: "fallback-remote",
		Create: func(_ string, _ VaultDefinition) (SecretVaultProvider, error) {
			return &fakeSecretVaultProvider{
				authCalls:  &[]VaultAuthConfig{},
				batchCalls: &fallbackBatchCalls,
				getCalls:   &[]string{},
				values:     map[string]any{"db.password": "fallback-remote-secret"},
			}, nil
		},
	}

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "prod",
		ResolvedAt: "2026-06-11T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"db.password": {Vault: "remote-prod", Ref: "db.password"},
		},
		Vaults: map[string]vaultDefinition{
			"remote-prod": {
				Provider: "primary-remote",
				Fallback: []vaultDefinition{
					{Provider: "fallback-remote"},
				},
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "prod", CnosVersion: "1.10.0"},
	}, Options{
		Environment:          map[string]string{},
		SecretHome:           t.TempDir(),
		SecretVaultProviders: []SecretVaultProviderFactory{primaryFactory, fallbackFactory},
	})

	password, ok, err := runtime.Secret("db.password")
	if err != nil {
		t.Fatalf("read custom fallback password: %v", err)
	}
	if !ok || password != "fallback-remote-secret" {
		t.Fatalf("expected fallback remote secret, got ok=%v value=%v", ok, password)
	}
	if len(primaryBatchCalls) != 1 || !reflect.DeepEqual(primaryBatchCalls[0], []string{"db.password"}) {
		t.Fatalf("expected primary batch call, got %#v", primaryBatchCalls)
	}
	if len(fallbackBatchCalls) != 1 || !reflect.DeepEqual(fallbackBatchCalls[0], []string{"db.password"}) {
		t.Fatalf("expected fallback batch call, got %#v", fallbackBatchCalls)
	}
}

func TestLoadProjectionRejectsConflictingSecretRefProvider(t *testing.T) {
	t.Parallel()

	runtime := mustLoadProjectionRuntime(t, ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "prod",
		ResolvedAt: "2026-06-11T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"db.password": {
				Provider: "environment",
				Vault:    "remote-prod",
				Ref:      "db.password",
			},
		},
		Vaults: map[string]vaultDefinition{
			"remote-prod": {
				Provider: "test-remote",
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "prod", CnosVersion: "1.10.0"},
	}, Options{
		Environment: map[string]string{"db.password": "should-not-resolve"},
		SecretHome:  t.TempDir(),
	})

	_, _, err := runtime.Secret("db.password")
	if err == nil {
		t.Fatal("expected conflicting secret ref provider to fail")
	}
	if got := err.Error(); got != `cnos: secret ref "secret.db.password" declares provider "environment" but vault "remote-prod" uses provider "test-remote"` {
		t.Fatalf("unexpected error: %s", got)
	}
}

func TestLoadProjectionResolvesRemoteProviderTokenFromFileAndKeychain(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token.txt")
	if err := os.WriteFile(tokenFile, []byte("file-token\n"), 0o600); err != nil {
		t.Fatalf("write token file: %v", err)
	}

	authCalls := []VaultAuthConfig{}
	batchCalls := [][]string{}
	factory := SecretVaultProviderFactory{
		Provider: "test-remote",
		Create: func(_ string, _ VaultDefinition) (SecretVaultProvider, error) {
			return &fakeSecretVaultProvider{
				authCalls:  &authCalls,
				batchCalls: &batchCalls,
				getCalls:   &[]string{},
				values:     map[string]any{"db.password": "remote-password"},
			}, nil
		},
	}

	runtime := mustLoadProjectionRuntime(t, remoteProviderProjection([]string{"file:" + tokenFile}), Options{
		Environment:          map[string]string{},
		SecretHome:           t.TempDir(),
		SecretVaultProviders: []SecretVaultProviderFactory{factory},
	})
	if err := runtime.warmSecrets(); err != nil {
		t.Fatalf("warm file-token secrets: %v", err)
	}
	if len(authCalls) != 1 || authCalls[0].Token != "file-token" {
		t.Fatalf("expected file token auth, got %#v", authCalls)
	}

	binDir := t.TempDir()
	installKeychainReadStub(t, binDir, "cnos/remote-prod", "keychain-token")
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	authCalls = []VaultAuthConfig{}
	batchCalls = [][]string{}
	runtime = mustLoadProjectionRuntime(t, remoteProviderProjection([]string{"keychain:cnos/remote-prod"}), Options{
		Environment:          map[string]string{},
		SecretHome:           t.TempDir(),
		SecretVaultProviders: []SecretVaultProviderFactory{factory},
	})
	if err := runtime.warmSecrets(); err != nil {
		t.Fatalf("warm keychain-token secrets: %v", err)
	}
	if len(authCalls) != 1 || authCalls[0].Token != "keychain-token" {
		t.Fatalf("expected keychain token auth, got %#v", authCalls)
	}
}

func TestSingletonReadyRegistersSecretVaultProvidersAfterProjectionBootstrap(t *testing.T) {
	resetDefaultRuntime()
	t.Cleanup(resetDefaultRuntime)

	authCalls := []VaultAuthConfig{}
	batchCalls := [][]string{}
	factory := SecretVaultProviderFactory{
		Provider: "test-remote",
		Create: func(_ string, _ VaultDefinition) (SecretVaultProvider, error) {
			return &fakeSecretVaultProvider{
				authCalls:  &authCalls,
				batchCalls: &batchCalls,
				getCalls:   &[]string{},
				values:     map[string]any{"db.password": "remote-password"},
			}, nil
		},
	}

	payload, err := json.Marshal(remoteProviderProjection([]string{"env:REMOTE_TOKEN"}))
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}
	t.Setenv(ProjectionEnvVar, string(payload))
	t.Setenv("REMOTE_TOKEN", "provider-token")
	bootstrapDefaultRuntime()

	if err := Ready(Options{SecretVaultProviders: []SecretVaultProviderFactory{factory}}); err != nil {
		t.Fatalf("ready with provider factory: %v", err)
	}
	value, ok, err := Secret("db.password")
	if err != nil {
		t.Fatalf("read singleton secret: %v", err)
	}
	if !ok || value != "remote-password" {
		t.Fatalf("expected singleton remote secret, got ok=%v value=%v", ok, value)
	}
	if len(batchCalls) != 1 || len(authCalls) != 1 {
		t.Fatalf("expected singleton warmup to batch once, got auth=%#v batch=%#v", authCalls, batchCalls)
	}
}

func remoteProviderProjection(tokenSources []string) ServerProjection {
	return ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "prod",
		ResolvedAt: "2026-06-11T00:00:00Z",
		ConfigHash: "hash",
		Values:     map[string]any{},
		Derived:    map[string]DerivedFormula{},
		SecretRefs: map[string]SecretReference{
			"db.password": {Vault: "remote-prod", Ref: "db.password"},
		},
		Vaults: map[string]vaultDefinition{
			"remote-prod": {
				Provider: "test-remote",
				Auth: vaultAuthFile{
					Method: "token",
					Token:  &vaultAuthSourceFile{From: tokenSources},
				},
			},
		},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "prod", CnosVersion: "1.10.0"},
	}
}
