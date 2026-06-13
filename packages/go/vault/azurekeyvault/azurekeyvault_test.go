package azurekeyvault

import (
	"context"
	"reflect"
	"strings"
	"testing"

	cnos "github.com/kitsyai/cnos/packages/go"
)

type fakeClient struct {
	calls  []secretCall
	values map[string]string
}

type secretCall struct {
	name    string
	version string
}

func (client *fakeClient) GetSecret(_ context.Context, name string, version string) (*string, error) {
	client.calls = append(client.calls, secretCall{name: name, version: version})
	key := name
	if version != "" {
		key += "/" + version
	}
	if value, ok := client.values[key]; ok {
		return &value, nil
	}
	if value, ok := client.values[name]; ok {
		return &value, nil
	}
	return nil, nil
}

func TestBatchGetUsesMappedSecrets(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{"app-token": "token", "db-password": "password"}}
	provider, err := New("azure-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"app-token": "app.token", "db-password": "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"vaultUrl": "https://acme-prod.vault.azure.net"},
		},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "iam"}); err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	values, err := provider.BatchGet([]string{"db.password", "app.token"})
	if err != nil {
		t.Fatalf("batch get: %v", err)
	}
	if !reflect.DeepEqual(values, map[string]any{"app.token": "token", "db.password": "password"}) {
		t.Fatalf("unexpected values: %#v", values)
	}
	if !reflect.DeepEqual(client.calls, []secretCall{{name: "app-token"}, {name: "db-password"}}) {
		t.Fatalf("unexpected calls: %#v", client.calls)
	}
}

func TestUsesConfiguredVersion(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{"db-password/version-123": "password"}}
	provider, err := New("azure-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"db-password": "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"vaultUrl": "https://acme-prod.vault.azure.net", "version": "version-123"},
		},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	value, err := provider.Get("db.password")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if value != "password" {
		t.Fatalf("unexpected value: %#v", value)
	}
	if !reflect.DeepEqual(client.calls, []secretCall{{name: "db-password", version: "version-123"}}) {
		t.Fatalf("unexpected calls: %#v", client.calls)
	}
}

func TestMappedFullSecretURLUsesURLVersion(t *testing.T) {
	t.Parallel()

	fullRef := "https://acme-prod.vault.azure.net/secrets/db-password/version-456"
	client := &fakeClient{values: map[string]string{"db-password/version-456": "password"}}
	provider, err := New("azure-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{fullRef: "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"vaultUrl": "https://acme-prod.vault.azure.net", "version": "ignored"},
		},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	values, err := provider.BatchGet([]string{"db.password"})
	if err != nil {
		t.Fatalf("batch get: %v", err)
	}
	if !reflect.DeepEqual(values, map[string]any{"db.password": "password"}) {
		t.Fatalf("unexpected values: %#v", values)
	}
	if !reflect.DeepEqual(client.calls, []secretCall{{name: "db-password", version: "version-456"}}) {
		t.Fatalf("unexpected calls: %#v", client.calls)
	}
}

func TestRejectsCrossVaultFullSecretURL(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{"db-password/version-456": "password"}}
	provider, err := New("azure-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"https://other.vault.azure.net/secrets/db-password/version-456": "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"vaultUrl": "https://acme-prod.vault.azure.net"},
		},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	_, err = provider.BatchGet([]string{"db.password"})
	if err == nil || !strings.Contains(err.Error(), "belongs to https://other.vault.azure.net") {
		t.Fatalf("expected cross-vault error, got %v", err)
	}
	if len(client.calls) != 0 {
		t.Fatalf("expected no client calls, got %#v", client.calls)
	}
}

func TestRejectsNonIAMAuth(t *testing.T) {
	t.Parallel()

	provider, err := New("azure-prod", cnos.VaultDefinition{Provider: Provider}, WithClient(&fakeClient{}))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "token"}); err == nil {
		t.Fatal("expected token auth to fail")
	}
}
