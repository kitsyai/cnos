// Package azure provides a compiled-in CNOS provider for Azure Key Vault.
package azure

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
	cnos "github.com/kitsyai/cnos/packages/go"
)

const Provider = "azure-key-vault"

// Client is the narrow Azure Key Vault client surface used by this provider.
type Client interface {
	GetSecret(ctx context.Context, name string, version string) (*string, error)
}

// Option configures the Azure Key Vault provider factory.
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

// Factory returns a CNOS provider factory for Azure Key Vault.
func Factory(configure ...Option) cnos.SecretVaultProviderFactory {
	return cnos.SecretVaultProviderFactory{
		Provider: Provider,
		Create: func(vaultID string, definition cnos.VaultDefinition) (cnos.SecretVaultProvider, error) {
			return New(vaultID, definition, configure...)
		},
	}
}

// New creates an Azure Key Vault CNOS provider instance.
func New(vaultID string, definition cnos.VaultDefinition, configure ...Option) (cnos.SecretVaultProvider, error) {
	options := options{}
	for _, apply := range configure {
		apply(&options)
	}
	config := readConfig(definition)
	client := options.client
	if client == nil {
		created, err := newSDKClient(config)
		if err != nil {
			return nil, err
		}
		client = created
	}
	return &provider{vaultID: vaultID, definition: definition, config: config, client: client}, nil
}

type vaultConfig struct {
	vaultURL string
	origin   string
	version  string
	tenantID string
	clientID string
}

type parsedSecretRef struct {
	name    string
	version string
	origin  string
	fullURL bool
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
	parsed, err := provider.secretRefForLogicalRef(ref)
	if err != nil {
		return nil, err
	}
	value, err := provider.client.GetSecret(ctx, parsed.name, parsed.version)
	if err != nil {
		if isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return value, nil
}

func (provider *provider) secretRefForLogicalRef(ref string) (parsedSecretRef, error) {
	external := provider.externalSecretIDForRef(ref)
	parsed, err := parseSecretRef(external)
	if err != nil {
		return parsedSecretRef{}, fmt.Errorf("vault %q has invalid Azure Key Vault ref %q: %w", provider.vaultID, external, err)
	}
	if parsed.fullURL && provider.config.origin != "" && parsed.origin != provider.config.origin {
		return parsedSecretRef{}, fmt.Errorf("vault %q Azure Key Vault ref %q belongs to %s, but vaultUrl is %s", provider.vaultID, external, parsed.origin, provider.config.origin)
	}
	if parsed.version == "" {
		parsed.version = provider.config.version
	}
	return parsed, nil
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
	vaultURL := firstStringConfig(config, "vaultUrl", "url", "endpoint")
	return vaultConfig{
		vaultURL: vaultURL,
		origin:   originForURL(vaultURL),
		version:  stringConfig(config, "version"),
		tenantID: firstStringConfig(config, "tenantId", "tenant"),
		clientID: stringConfig(config, "clientId"),
	}
}

func parseSecretRef(ref string) (parsedSecretRef, error) {
	trimmed := strings.TrimSpace(ref)
	if !strings.HasPrefix(trimmed, "https://") && !strings.HasPrefix(trimmed, "http://") {
		if trimmed == "" {
			return parsedSecretRef{}, errors.New("secret name cannot be empty")
		}
		return parsedSecretRef{name: trimmed}, nil
	}

	parsedURL, err := url.Parse(trimmed)
	if err != nil {
		return parsedSecretRef{}, err
	}
	segments := pathSegments(parsedURL.Path)
	if len(segments) < 2 || len(segments) > 3 || segments[0] != "secrets" {
		return parsedSecretRef{}, errors.New("full URL must use /secrets/<name>[/<version>]")
	}
	name, err := url.PathUnescape(segments[1])
	if err != nil {
		return parsedSecretRef{}, err
	}
	if name == "" {
		return parsedSecretRef{}, errors.New("secret name cannot be empty")
	}
	secret := parsedSecretRef{name: name, origin: originForParsedURL(parsedURL), fullURL: true}
	if len(segments) == 3 {
		version, err := url.PathUnescape(segments[2])
		if err != nil {
			return parsedSecretRef{}, err
		}
		secret.version = version
	}
	return secret, nil
}

func pathSegments(path string) []string {
	result := []string{}
	for _, segment := range strings.Split(path, "/") {
		if segment != "" {
			result = append(result, segment)
		}
	}
	return result
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

func originForURL(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	return originForParsedURL(parsed)
}

func originForParsedURL(parsedURL *url.URL) string {
	if parsedURL == nil || parsedURL.Scheme == "" || parsedURL.Host == "" {
		return ""
	}
	return strings.ToLower(parsedURL.Scheme + "://" + parsedURL.Host)
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

func isNotFound(err error) bool {
	var responseError *azcore.ResponseError
	return errors.As(err, &responseError) && responseError.StatusCode == http.StatusNotFound
}

type sdkClient struct {
	client *azsecrets.Client
}

func newSDKClient(config vaultConfig) (Client, error) {
	if config.vaultURL == "" {
		return nil, errors.New("Azure Key Vault provider requires auth.config.vaultUrl")
	}
	credential, err := newCredential(config)
	if err != nil {
		return nil, err
	}
	client, err := azsecrets.NewClient(config.vaultURL, credential, nil)
	if err != nil {
		return nil, err
	}
	return &sdkClient{client: client}, nil
}

func newCredential(config vaultConfig) (azcore.TokenCredential, error) {
	defaultCredential, err := azidentity.NewDefaultAzureCredential(&azidentity.DefaultAzureCredentialOptions{
		TenantID: config.tenantID,
	})
	if err != nil {
		return nil, err
	}
	if config.clientID != "" {
		managedIdentity, err := azidentity.NewManagedIdentityCredential(&azidentity.ManagedIdentityCredentialOptions{
			ID: azidentity.ClientID(config.clientID),
		})
		if err != nil {
			return nil, err
		}
		return azidentity.NewChainedTokenCredential([]azcore.TokenCredential{managedIdentity, defaultCredential}, nil)
	}
	return defaultCredential, nil
}

func (client *sdkClient) GetSecret(ctx context.Context, name string, version string) (*string, error) {
	response, err := client.client.GetSecret(ctx, name, version, nil)
	if err != nil {
		return nil, err
	}
	return response.Value, nil
}
