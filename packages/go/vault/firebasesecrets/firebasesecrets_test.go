package firebasesecrets

import (
	"context"
	"reflect"
	"testing"

	cnos "github.com/kitsyai/cnos/packages/go"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeClient struct {
	calls  []string
	values map[string]string
}

func (client *fakeClient) AccessSecretVersion(_ context.Context, name string) ([]byte, error) {
	client.calls = append(client.calls, name)
	if value, ok := client.values[name]; ok {
		return []byte(value), nil
	}
	return nil, status.Error(codes.NotFound, "missing")
}

func (client *fakeClient) ProjectID(context.Context) (string, error) {
	return "firebase-project", nil
}

func (client *fakeClient) Close() error {
	return nil
}

func TestFirebaseSecretsUsesSecretManagerBackingStore(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{
		"projects/firebase-project/secrets/DB_PASSWORD/versions/latest": "password",
	}}
	provider, err := New("firebase-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"DB_PASSWORD": "db.password"},
		Auth:     cnos.VaultAuthDefinition{Method: "iam"},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "iam"}); err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	values, err := provider.BatchGet([]string{"db.password"})
	if err != nil {
		t.Fatalf("batch get: %v", err)
	}
	if !reflect.DeepEqual(values, map[string]any{"db.password": "password"}) {
		t.Fatalf("unexpected values: %#v", values)
	}
	if !reflect.DeepEqual(client.calls, []string{"projects/firebase-project/secrets/DB_PASSWORD/versions/latest"}) {
		t.Fatalf("unexpected calls: %#v", client.calls)
	}
}
