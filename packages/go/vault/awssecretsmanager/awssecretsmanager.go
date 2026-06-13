// Package awssecretsmanager provides a compiled-in CNOS provider for AWS Secrets Manager.
package awssecretsmanager

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager/types"
	"github.com/aws/smithy-go"
	cnos "github.com/kitsyai/cnos/packages/go"
)

const Provider = "aws-secrets-manager"

// Client is the narrow AWS Secrets Manager client surface used by this provider.
type Client interface {
	BatchGetSecretValue(ctx context.Context, input *secretsmanager.BatchGetSecretValueInput, optFns ...func(*secretsmanager.Options)) (*secretsmanager.BatchGetSecretValueOutput, error)
	GetSecretValue(ctx context.Context, input *secretsmanager.GetSecretValueInput, optFns ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error)
}

// Option configures the AWS Secrets Manager provider factory.
type Option func(*options)

type options struct {
	client Client
}

// WithClient injects a client, primarily for tests or custom transports.
func WithClient(client Client) Option {
	return func(options *options) {
		options.client = client
	}
}

// Factory returns a CNOS provider factory for AWS Secrets Manager.
func Factory(configure ...Option) cnos.SecretVaultProviderFactory {
	return cnos.SecretVaultProviderFactory{
		Provider: Provider,
		Create: func(vaultID string, definition cnos.VaultDefinition) (cnos.SecretVaultProvider, error) {
			return New(vaultID, definition, configure...)
		},
	}
}

// New creates an AWS Secrets Manager CNOS provider instance.
func New(vaultID string, definition cnos.VaultDefinition, configure ...Option) (cnos.SecretVaultProvider, error) {
	options := options{}
	for _, apply := range configure {
		apply(&options)
	}
	config := readConfig(definition)
	client := options.client
	if client == nil {
		created, err := newSDKClient(context.Background(), config)
		if err != nil {
			return nil, err
		}
		client = created
	}
	return &provider{vaultID: vaultID, definition: definition, config: config, client: client}, nil
}

type vaultConfig struct {
	region       string
	endpoint     string
	versionID    string
	versionStage string
}

type provider struct {
	vaultID       string
	definition    cnos.VaultDefinition
	config        vaultConfig
	client        Client
	authenticated bool
}

func (provider *provider) Authenticate(auth cnos.VaultAuthConfig) error {
	if auth.Method != "iam" && auth.Method != "environment" {
		return fmt.Errorf("vault %q uses %s and requires iam authentication", provider.vaultID, Provider)
	}
	provider.authenticated = true
	return nil
}

func (provider *provider) BatchGet(refs []string) (map[string]any, error) {
	requestedRefs := uniqueRefs(refs)
	resolved := map[string]any{}
	if provider.config.versionID != "" || provider.config.versionStage != "" {
		for _, ref := range requestedRefs {
			value, err := provider.getOne(context.Background(), ref)
			if err != nil {
				return nil, err
			}
			if value != nil {
				resolved[ref] = *value
			}
		}
		return resolved, nil
	}

	externalToLogical := map[string]string{}
	secretIDs := []string{}
	for _, ref := range requestedRefs {
		external := provider.externalSecretIDForRef(ref)
		externalToLogical[external] = ref
		secretIDs = append(secretIDs, external)
	}
	output, err := provider.client.BatchGetSecretValue(context.Background(), &secretsmanager.BatchGetSecretValueInput{
		SecretIdList: secretIDs,
	})
	if err != nil {
		if !isResourceNotFound(err) {
			return nil, err
		}
		return provider.getEach(requestedRefs)
	}
	if err := assertBatchErrors(output.Errors); err != nil {
		return nil, err
	}
	for _, secret := range output.SecretValues {
		ref := provider.resolveOutputRef(secret, externalToLogical)
		value := decodeSecretValue(secret)
		if ref != "" && value != nil {
			resolved[ref] = *value
		}
	}
	return resolved, nil
}

func (provider *provider) Get(ref string) (any, error) {
	value, err := provider.getOne(context.Background(), ref)
	if err != nil || value == nil {
		return nil, err
	}
	return *value, nil
}

func (provider *provider) getEach(refs []string) (map[string]any, error) {
	resolved := map[string]any{}
	for _, ref := range refs {
		value, err := provider.getOne(context.Background(), ref)
		if err != nil {
			return nil, err
		}
		if value != nil {
			resolved[ref] = *value
		}
	}
	return resolved, nil
}

func (provider *provider) getOne(ctx context.Context, ref string) (*string, error) {
	output, err := provider.client.GetSecretValue(ctx, provider.secretValueInput(ref))
	if err != nil {
		if isResourceNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	value := decodeGetSecretValue(output)
	return value, nil
}

func (provider *provider) secretValueInput(ref string) *secretsmanager.GetSecretValueInput {
	input := &secretsmanager.GetSecretValueInput{SecretId: aws.String(provider.externalSecretIDForRef(ref))}
	if provider.config.versionID != "" {
		input.VersionId = aws.String(provider.config.versionID)
	}
	if provider.config.versionStage != "" {
		input.VersionStage = aws.String(provider.config.versionStage)
	}
	return input
}

func (provider *provider) externalSecretIDForRef(ref string) string {
	for external, logical := range provider.definition.Mapping {
		if logical == ref {
			return external
		}
	}
	return ref
}

func (provider *provider) logicalRefForExternalSecretID(secretID string) string {
	if logical, ok := provider.definition.Mapping[secretID]; ok {
		return logical
	}
	return secretID
}

func (provider *provider) resolveOutputRef(secret types.SecretValueEntry, requestedRefs map[string]string) string {
	if secret.ARN != nil {
		if ref, ok := requestedRefs[aws.ToString(secret.ARN)]; ok {
			return ref
		}
	}
	if secret.Name != nil {
		name := aws.ToString(secret.Name)
		if ref, ok := requestedRefs[name]; ok {
			return ref
		}
		return provider.logicalRefForExternalSecretID(name)
	}
	return ""
}

func readConfig(definition cnos.VaultDefinition) vaultConfig {
	config := definition.Auth.Config
	return vaultConfig{
		region:       stringConfig(config, "region"),
		endpoint:     stringConfig(config, "endpoint"),
		versionID:    firstStringConfig(config, "versionId", "version"),
		versionStage: stringConfig(config, "versionStage"),
	}
}

func stringConfig(config map[string]any, key string) string {
	if config == nil {
		return ""
	}
	value, ok := config[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func firstStringConfig(config map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringConfig(config, key); value != "" {
			return value
		}
	}
	return ""
}

func uniqueRefs(refs []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, ref := range refs {
		if !seen[ref] {
			seen[ref] = true
			result = append(result, ref)
		}
	}
	sort.Strings(result)
	return result
}

func assertBatchErrors(errors []types.APIErrorType) error {
	for _, batchError := range errors {
		if aws.ToString(batchError.ErrorCode) == "ResourceNotFoundException" {
			continue
		}
		message := aws.ToString(batchError.ErrorCode)
		if message == "" {
			message = "UnknownError"
		}
		if batchError.Message != nil {
			message += ": " + aws.ToString(batchError.Message)
		}
		return fmt.Errorf("AWS Secrets Manager batch read failed for %q: %s", aws.ToString(batchError.SecretId), message)
	}
	return nil
}

func decodeSecretValue(secret types.SecretValueEntry) *string {
	if secret.SecretString != nil {
		value := aws.ToString(secret.SecretString)
		return &value
	}
	if secret.SecretBinary != nil {
		value := string(secret.SecretBinary)
		return &value
	}
	return nil
}

func decodeGetSecretValue(secret *secretsmanager.GetSecretValueOutput) *string {
	if secret.SecretString != nil {
		value := aws.ToString(secret.SecretString)
		return &value
	}
	if secret.SecretBinary != nil {
		value := string(secret.SecretBinary)
		return &value
	}
	return nil
}

func isResourceNotFound(err error) bool {
	var apiError smithy.APIError
	return errors.As(err, &apiError) && apiError.ErrorCode() == "ResourceNotFoundException"
}

func newSDKClient(ctx context.Context, vaultConfig vaultConfig) (Client, error) {
	loadOptions := []func(*config.LoadOptions) error{}
	if vaultConfig.region != "" {
		loadOptions = append(loadOptions, config.WithRegion(vaultConfig.region))
	}
	awsConfig, err := config.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		return nil, err
	}
	clientOptions := []func(*secretsmanager.Options){}
	if vaultConfig.endpoint != "" {
		clientOptions = append(clientOptions, func(options *secretsmanager.Options) {
			options.EndpointResolver = secretsmanager.EndpointResolverFromURL(vaultConfig.endpoint)
		})
	}
	return secretsmanager.NewFromConfig(awsConfig, clientOptions...), nil
}
