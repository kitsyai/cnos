package awssecretsmanager

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager/types"
	smithy "github.com/aws/smithy-go"
	cnos "github.com/kitsyai/cnos/packages/go"
)

const directARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:direct/arn-AbCdEf"

type fakeClient struct {
	batchInputs []*secretsmanager.BatchGetSecretValueInput
	getInputs   []*secretsmanager.GetSecretValueInput
	batchErrors []types.APIErrorType
	values      map[string]string
}

func (client *fakeClient) BatchGetSecretValue(_ context.Context, input *secretsmanager.BatchGetSecretValueInput, _ ...func(*secretsmanager.Options)) (*secretsmanager.BatchGetSecretValueOutput, error) {
	client.batchInputs = append(client.batchInputs, input)
	output := &secretsmanager.BatchGetSecretValueOutput{Errors: client.batchErrors}
	for _, id := range input.SecretIdList {
		if value, ok := client.values[id]; ok {
			entry := types.SecretValueEntry{Name: aws.String(id), SecretString: aws.String(value)}
			if id == directARN {
				entry.Name = aws.String("direct/arn")
				entry.ARN = aws.String(directARN)
			}
			output.SecretValues = append(output.SecretValues, entry)
		}
	}
	return output, nil
}

func (client *fakeClient) GetSecretValue(_ context.Context, input *secretsmanager.GetSecretValueInput, _ ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error) {
	client.getInputs = append(client.getInputs, input)
	secretID := aws.ToString(input.SecretId)
	if value, ok := client.values[secretID]; ok {
		return &secretsmanager.GetSecretValueOutput{Name: aws.String(secretID), SecretString: aws.String(value)}, nil
	}
	return nil, resourceNotFoundError{}
}

type resourceNotFoundError struct{}

func (resourceNotFoundError) Error() string {
	return "not found"
}

func (resourceNotFoundError) ErrorCode() string {
	return "ResourceNotFoundException"
}

func (resourceNotFoundError) ErrorMessage() string {
	return "not found"
}

func (resourceNotFoundError) ErrorFault() smithy.ErrorFault {
	return smithy.FaultClient
}

func TestBatchGetUsesMappedSecrets(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{"app/token": "token", "db/password": "password"}}
	provider, err := New("aws-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"app/token": "app.token", "db/password": "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"region": "us-east-1"},
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
	if len(client.batchInputs) != 1 || !reflect.DeepEqual(client.batchInputs[0].SecretIdList, []string{"app/token", "db/password"}) {
		t.Fatalf("unexpected batch inputs: %#v", client.batchInputs)
	}
	if len(client.getInputs) != 0 {
		t.Fatalf("expected no get calls, got %#v", client.getInputs)
	}
}

func TestPinnedVersionUsesGetSecretValue(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{"db/password": "password"}}
	provider, err := New("aws-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"db/password": "db.password"},
		Auth: cnos.VaultAuthDefinition{
			Method: "iam",
			Config: map[string]any{"region": "us-east-1", "versionId": "version-123"},
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
	if len(client.batchInputs) != 0 {
		t.Fatalf("expected no batch calls, got %#v", client.batchInputs)
	}
	if len(client.getInputs) != 1 || aws.ToString(client.getInputs[0].VersionId) != "version-123" {
		t.Fatalf("unexpected get inputs: %#v", client.getInputs)
	}
}

func TestDirectARNRemainsCacheKey(t *testing.T) {
	t.Parallel()

	client := &fakeClient{values: map[string]string{directARN: "arn-secret"}}
	provider, err := New("aws-prod", cnos.VaultDefinition{Provider: Provider}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	values, err := provider.BatchGet([]string{directARN})
	if err != nil {
		t.Fatalf("batch get: %v", err)
	}
	if !reflect.DeepEqual(values, map[string]any{directARN: "arn-secret"}) {
		t.Fatalf("unexpected values: %#v", values)
	}
}

func TestBatchErrorsFailExceptMissing(t *testing.T) {
	t.Parallel()

	client := &fakeClient{
		values: map[string]string{"db/password": "password"},
		batchErrors: []types.APIErrorType{
			{ErrorCode: aws.String("ResourceNotFoundException"), SecretId: aws.String("missing")},
			{ErrorCode: aws.String("DecryptionFailure"), Message: aws.String("kms denied"), SecretId: aws.String("db/password")},
		},
	}
	provider, err := New("aws-prod", cnos.VaultDefinition{
		Provider: Provider,
		Mapping:  map[string]string{"db/password": "db.password"},
	}, WithClient(client))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	_, err = provider.BatchGet([]string{"db.password"})
	if err == nil || !strings.Contains(err.Error(), "DecryptionFailure") {
		t.Fatalf("expected decryption failure, got %v", err)
	}
}

func TestRejectsNonIAMAuth(t *testing.T) {
	t.Parallel()

	provider, err := New("aws-prod", cnos.VaultDefinition{Provider: Provider}, WithClient(&fakeClient{}))
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if err := provider.Authenticate(cnos.VaultAuthConfig{Method: "token"}); err == nil {
		t.Fatal("expected token auth to fail")
	}
}
