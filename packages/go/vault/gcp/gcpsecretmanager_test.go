package gcp

import (
	"context"
	"errors"
	"reflect"
	"testing"

	cnos "github.com/kitsyai/cnos/packages/go"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeClient struct {
	projectID string
	calls     []string
	values    map[string]string
}

func (client *fakeClient) AccessSecretVersion(_ context.Context, name string) ([]byte, error) {
	client.calls = append(client.calls, name)
	if value, ok := client.values[name]; ok {
		return []byte(value), nil
	}
	return nil, status.Error(codes.NotFound, "missing")
}

func (client *fakeClient) ProjectID(context.Context) (string, error) {
	if client.projectID == "" {
		return "", errors.New("missing project")
	}
	return client.projectID, nil
}

func (client *fakeClient) Close() error {
	return nil
}

func TestBatchGetUsesMappedSecretManagerRefs(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{
		"projects/acme/secrets/app-token/versions/latest":   "token",
		"projects/acme/secrets/db-password/versions/latest": "password",
	}}
	provider, err := New("gcp-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"app-token": "app.token", "db-password": "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"projectId": "acme"},
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
	if !reflect.DeepEqual(client.calls, []string{
		"projects/acme/secrets/app-token/versions/latest",
		"projects/acme/secrets/db-password/versions/latest",
	}) {
		t.Fatalf("unexpected calls: %#v", client.calls)
	}
}

func TestMappedFullSecretManagerVersionRefPassesThrough(t *testing.T) {
	t.Parallel()

	fullRef := "projects/other/secrets/db-password/versions/5"
	client := &fakeClient{values: map[string]string{fullRef: "password"}}
	provider, err := New("gcp-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{fullRef: "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"projectId": "ignored", "version": "ignored"},
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
	if !reflect.DeepEqual(client.calls, []string{fullRef}) {
		t.Fatalf("unexpected calls: %#v", client.calls)
	}
}

func TestUsesSDKProjectIDFallback(t *testing.T) {
	t.Parallel()

	client := &fakeClient{
		projectID: "adc-project",
		values: map[string]string{
			"projects/adc-project/secrets/db-password/versions/latest": "password",
		},
	}
	provider, err := New("gcp-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"db-password": "db.password"},
		Auth:     cnos.VaultAuthDefinition{Method: "iam"},
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
}

func TestRejectsNonIAMAuth(t *testing.T) {
	t.Parallel()

	provider, err := New("gcp-prod", cnos.VaultDefinition{Provider: Provider}, WithClient(&fakeClient{}))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "token"}); err == nil {
		t.Fatal("expected token auth to fail")
	}
}
