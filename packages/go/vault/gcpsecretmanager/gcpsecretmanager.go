// Package gcpsecretmanager provides a compiled-in CNOS provider for Google Secret Manager.
package gcpsecretmanager

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	secretmanager "cloud.google.com/go/secretmanager/apiv1"
	secretmanagerpb "cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
	cnos "github.com/kitsyai/cnos/packages/go"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/option"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const Provider = "gcp-secret-manager"

var fullSecretVersionName = regexp.MustCompile(`^projects/[^/]+/(locations/[^/]+/)?secrets/[^/]+/versions/[^/]+$`)

// Client is the narrow Secret Manager client surface used by this provider.
type Client interface {
	AccessSecretVersion(ctx context.Context, name string) ([]byte, error)
	ProjectID(ctx context.Context) (string, error)
	Close() error
}

// Option configures the Google Secret Manager provider factory.
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

// Factory returns a CNOS provider factory for Google Secret Manager.
func Factory(configure ...Option) cnos.SecretVaultProviderFactory {
	return cnos.SecretVaultProviderFactory{
		Provider: Provider,
		Create: func(vaultID string, definition cnos.VaultDefinition) (cnos.SecretVaultProvider, error) {
			return New(vaultID, definition, configure...)
		},
	}
}

// New creates a Google Secret Manager CNOS provider instance.
func New(vaultID string, definition cnos.VaultDefinition, configure ...Option) (cnos.SecretVaultProvider, error) {
	options := options{}
	for _, apply := range configure {
		apply(&options)
	}
	config := readConfig(definition)
	client := options.client
	if client == nil {
		created, err := newSDKClient(context.Background(), config.endpoint)
		if err != nil {
			return nil, err
		}
		client = created
	}
	return &provider{vaultID: vaultID, definition: definition, config: config, client: client}, nil
}

type vaultConfig struct {
	projectID string
	location  string
	version   string
	endpoint  string
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
	result := map[string]any{}
	for _, ref := range uniqueRefs(refs) {
		value, err := provider.getOne(context.Background(), ref)
		if err != nil {
			return nil, err
		}
		if value != nil {
			result[ref] = *value
		}
	}
	return result, nil
}

func (provider *provider) Get(ref string) (any, error) {
	value, err := provider.getOne(context.Background(), ref)
	if err != nil || value == nil {
		return nil, err
	}
	return *value, nil
}

func (provider *provider) getOne(ctx context.Context, ref string) (*string, error) {
	name, err := provider.versionNameForRef(ctx, ref)
	if err != nil {
		return nil, err
	}
	data, err := provider.client.AccessSecretVersion(ctx, name)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, nil
		}
		return nil, err
	}
	value := string(data)
	return &value, nil
}

func (provider *provider) versionNameForRef(ctx context.Context, ref string) (string, error) {
	secretID := provider.externalSecretIDForRef(ref)
	if fullSecretVersionName.MatchString(secretID) {
		return secretID, nil
	}
	projectID, err := provider.resolveProjectID(ctx)
	if err != nil {
		return "", err
	}
	version := provider.config.version
	if version == "" {
		version = "latest"
	}
	if provider.config.location != "" {
		return fmt.Sprintf("projects/%s/locations/%s/secrets/%s/versions/%s", projectID, provider.config.location, secretID, version), nil
	}
	return fmt.Sprintf("projects/%s/secrets/%s/versions/%s", projectID, secretID, version), nil
}

func (provider *provider) resolveProjectID(ctx context.Context) (string, error) {
	if provider.config.projectID != "" {
		return provider.config.projectID, nil
	}
	projectID, err := provider.client.ProjectID(ctx)
	if err == nil && projectID != "" {
		return projectID, nil
	}
	return "", fmt.Errorf("vault %q requires auth.config.projectId when Google ADC cannot infer a project ID", provider.vaultID)
}

func (provider *provider) externalSecretIDForRef(ref string) string {
	for external, logical := range provider.definition.Mapping {
		if logical == ref {
			return external
		}
	}
	return ref
}

func readConfig(definition cnos.VaultDefinition) vaultConfig {
	config := definition.Auth.Config
	return vaultConfig{
		projectID: stringConfig(config, "projectId"),
		location:  stringConfig(config, "location"),
		version:   stringConfig(config, "version"),
		endpoint:  firstStringConfig(config, "endpoint", "apiEndpoint"),
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

type sdkClient struct {
	client *secretmanager.Client
}

func newSDKClient(ctx context.Context, endpoint string) (Client, error) {
	clientOptions := []option.ClientOption{}
	if endpoint != "" {
		clientOptions = append(clientOptions, option.WithEndpoint(endpoint))
	}
	client, err := secretmanager.NewClient(ctx, clientOptions...)
	if err != nil {
		return nil, err
	}
	return &sdkClient{client: client}, nil
}

func (client *sdkClient) AccessSecretVersion(ctx context.Context, name string) ([]byte, error) {
	response, err := client.client.AccessSecretVersion(ctx, &secretmanagerpb.AccessSecretVersionRequest{Name: name})
	if err != nil {
		return nil, err
	}
	return response.GetPayload().GetData(), nil
}

func (client *sdkClient) ProjectID(ctx context.Context) (string, error) {
	credentials, err := google.FindDefaultCredentials(ctx, secretmanager.DefaultAuthScopes()...)
	if err != nil {
		return "", err
	}
	return credentials.ProjectID, nil
}

func (client *sdkClient) Close() error {
	return client.client.Close()
}
