package hashicorp

import (
	"context"
	"reflect"
	"testing"

	cnos "github.com/kitsyai/cnos/packages/go"
)

type fakeClient struct {
	calls []vaultCall
	data  map[string]map[string]any
}

type vaultCall struct {
	path      string
	token     string
	namespace string
}

func (client *fakeClient) Read(_ context.Context, path string, token string, namespace string) (map[string]any, int, error) {
	client.calls = append(client.calls, vaultCall{path: path, token: token, namespace: namespace})
	data, ok := client.data[path]
	if !ok {
		return nil, 404, nil
	}
	return data, 200, nil
}

func TestReadsKVV2MappedField(t *testing.T) {
	t.Parallel()

	client := &fakeClient{data: map[string]map[string]any{
		"secret/data/team/db/password": {
			"data": map[string]any{"password": "vault-password", "username": "app"},
		},
	}}
	provider, err := New("vault-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"db/password#password": "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "token",
			Config: map[string]any{
				"address":   "https://vault.example.com",
				"mount":     "secret",
				"path":      "team",
				"namespace": "admin/team-a",
				"version":   2,
			},
		},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "token", Token: "vault-token"}); err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	values, err := provider.BatchGet([]string{"db.password"})
	if err != nil {
		t.Fatalf("batch get: %v", err)
	}
	if !reflect.DeepEqual(values, map[string]any{"db.password": "vault-password"}) {
		t.Fatalf("unexpected values: %#v", values)
	}
	if !reflect.DeepEqual(client.calls, []vaultCall{{path: "secret/data/team/db/password", token: "vault-token", namespace: "admin/team-a"}}) {
		t.Fatalf("unexpected calls: %#v", client.calls)
	}
}

func TestReadsKVV1(t *testing.T) {
	t.Parallel()

	client := &fakeClient{data: map[string]map[string]any{
		"secret/db/password": {"value": "vault-password"},
	}}
	provider, err := New("vault-prod", cnos.VaultDefinition{
		Provider: Provider,
		Auth: cnos.VaultAuthDefinition{
			Method: "token",
			Config: map[string]any{"version": "1"},
		},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "token", Token: "vault-token"}); err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	value, err := provider.Get("db/password")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if value != "vault-password" {
		t.Fatalf("unexpected value: %#v", value)
	}
}

func TestExplicitMissingFieldDoesNotFallbackToOnlyPrimitive(t *testing.T) {
	t.Parallel()

	client := &fakeClient{data: map[string]map[string]any{
		"secret/data/db/password": {
			"data": map[string]any{"username": "app"},
		},
	}}
	provider, err := New("vault-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"db/password#password": "db.password"},
		Auth:     cnos.VaultAuthDefinition{Method: "token"},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "token", Token: "vault-token"}); err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	values, err := provider.BatchGet([]string{"db.password"})
	if err != nil {
		t.Fatalf("batch get: %v", err)
	}
	if len(values) != 0 {
		t.Fatalf("expected no fallback value, got %#v", values)
	}
}

func TestRejectsMissingToken(t *testing.T) {
	t.Parallel()

	provider, err := New("vault-prod", cnos.VaultDefinition{Provider: Provider}, WithClient(&fakeClient{}))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "token"}); err == nil {
		t.Fatal("expected missing token auth to fail")
	}
}
