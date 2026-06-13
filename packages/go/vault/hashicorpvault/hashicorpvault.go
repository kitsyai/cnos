// Package hashicorpvault provides a compiled-in CNOS provider for HashiCorp Vault.
package hashicorpvault

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	vaultapi "github.com/hashicorp/vault/api"
	cnos "github.com/kitsyai/cnos/packages/go"
)

const Provider = "hashicorp-vault"

// Client is the narrow Vault client surface used by this provider.
type Client interface {
	Read(ctx context.Context, path string, token string, namespace string) (map[string]any, int, error)
}

// Option configures the HashiCorp Vault provider factory.
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

// Factory returns a CNOS provider factory for HashiCorp Vault.
func Factory(configure ...Option) cnos.SecretVaultProviderFactory {
	return cnos.SecretVaultProviderFactory{
		Provider: Provider,
		Create: func(vaultID string, definition cnos.VaultDefinition) (cnos.SecretVaultProvider, error) {
			return New(vaultID, definition, configure...)
		},
	}
}

// New creates a HashiCorp Vault CNOS provider instance.
func New(vaultID string, definition cnos.VaultDefinition, configure ...Option) (cnos.SecretVaultProvider, error) {
	options := options{}
	for _, apply := range configure {
		apply(&options)
	}
	config := readConfig(definition)
	client := options.client
	if client == nil {
		created, err := newSDKClient(config.address)
		if err != nil {
			return nil, err
		}
		client = created
	}
	return &provider{vaultID: vaultID, definition: definition, config: config, client: client}, nil
}

type vaultConfig struct {
	address   string
	mount     string
	namespace string
	version   int
	path      string
}

type parsedRef struct {
	path          string
	field         string
	explicitField bool
}

type provider struct {
	vaultID       string
	definition    cnos.VaultDefinition
	config        vaultConfig
	client        Client
	token         string
	authenticated bool
}

func (provider *provider) Authenticate(auth cnos.VaultAuthConfig) error {
	if auth.Method != "token" || auth.Token == "" {
		return fmt.Errorf("vault %q uses %s and requires token authentication", provider.vaultID, Provider)
	}
	provider.token = auth.Token
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
	external := provider.externalRefForLogicalRef(ref)
	parsed := parseVaultRef(external)
	data, status, err := provider.client.Read(ctx, provider.readPath(parsed.path), provider.token, provider.config.namespace)
	if err != nil {
		return nil, err
	}
	if status == 404 || data == nil {
		return nil, nil
	}
	value := decodeVaultValue(readKVData(data, provider.config.version), parsed.field, parsed.explicitField)
	return value, nil
}

func (provider *provider) externalRefForLogicalRef(ref string) string {
	for external, logical := range provider.definition.Mapping {
		if logical == ref {
			return external
		}
	}
	return ref
}

func (provider *provider) readPath(path string) string {
	if provider.config.version == 2 {
		return joinPath(provider.config.mount, "data", provider.config.path, path)
	}
	return joinPath(provider.config.mount, provider.config.path, path)
}

func readConfig(definition cnos.VaultDefinition) vaultConfig {
	config := definition.Auth.Config
	version := readVersion(config["version"])
	if version == 0 {
		version = 2
	}
	mount := stringConfig(config, "mount")
	if mount == "" {
		mount = "secret"
	}
	return vaultConfig{
		address:   firstStringConfig(config, "address", "endpoint", "url"),
		mount:     mount,
		namespace: stringConfig(config, "namespace"),
		version:   version,
		path:      stringConfig(config, "path"),
	}
}

func parseVaultRef(ref string) parsedRef {
	index := strings.LastIndex(ref, "#")
	if index == -1 {
		return parsedRef{path: ref, field: "value"}
	}
	field := ref[index+1:]
	if field == "" {
		field = "value"
	}
	return parsedRef{path: ref[:index], field: field, explicitField: true}
}

func readKVData(data map[string]any, version int) map[string]any {
	if version != 2 {
		return data
	}
	nested, ok := data["data"].(map[string]any)
	if !ok {
		return nil
	}
	return nested
}

func decodeVaultValue(data map[string]any, field string, explicitField bool) *string {
	if data == nil {
		return nil
	}
	if value, ok := primitiveString(data[field]); ok {
		return &value
	}
	if explicitField {
		return nil
	}
	primitives := []string{}
	for _, value := range data {
		if primitive, ok := primitiveString(value); ok {
			primitives = append(primitives, primitive)
		}
	}
	if len(primitives) == 1 {
		return &primitives[0]
	}
	return nil
}

func primitiveString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case int:
		return strconv.Itoa(typed), true
	case int64:
		return strconv.FormatInt(typed, 10), true
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(typed), true
	default:
		return "", false
	}
}

func joinPath(segments ...string) string {
	result := []string{}
	for _, segment := range segments {
		trimmed := strings.Trim(segment, "/")
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return strings.Join(result, "/")
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

func readVersion(value any) int {
	switch typed := value.(type) {
	case int:
		if typed == 1 || typed == 2 {
			return typed
		}
	case string:
		switch strings.TrimSpace(typed) {
		case "1", "kv-v1":
			return 1
		case "2", "kv-v2":
			return 2
		}
	}
	return 0
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
	client *vaultapi.Client
}

func newSDKClient(address string) (Client, error) {
	config := vaultapi.DefaultConfig()
	if address != "" {
		config.Address = address
	}
	client, err := vaultapi.NewClient(config)
	if err != nil {
		return nil, err
	}
	return &sdkClient{client: client}, nil
}

func (client *sdkClient) Read(ctx context.Context, path string, token string, namespace string) (map[string]any, int, error) {
	client.client.SetToken(token)
	client.client.SetNamespace(namespace)
	secret, err := client.client.Logical().ReadWithContext(ctx, path)
	if err != nil {
		var responseError *vaultapi.ResponseError
		if errors.As(err, &responseError) && responseError.StatusCode == 404 {
			return nil, 404, nil
		}
		return nil, 0, err
	}
	if secret == nil {
		return nil, 404, nil
	}
	return secret.Data, 200, nil
}
