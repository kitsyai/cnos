package cnos

import (
	"fmt"
	"os"
	"strings"
)

// VaultAuthSource describes where runtime auth material can be resolved from.
type VaultAuthSource struct {
	From []string
}

// VaultAuthDefinition is the non-secret auth metadata projected for a vault.
type VaultAuthDefinition struct {
	Method     string
	Passphrase *VaultAuthSource
	Token      *VaultAuthSource
	Config     map[string]any
}

// VaultDefinition is the runtime-safe vault definition passed to providers.
type VaultDefinition struct {
	Provider string
	Auth     VaultAuthDefinition
	Mapping  map[string]string
	Fallback []VaultDefinition
}

// VaultAuthConfig contains resolved in-memory auth material for a vault.
type VaultAuthConfig struct {
	Method     string
	Passphrase string
	Token      string
	Config     map[string]any
}

// SecretVaultProvider resolves secret refs from a vault backend.
type SecretVaultProvider interface {
	Authenticate(auth VaultAuthConfig) error
	BatchGet(refs []string) (map[string]any, error)
	Get(ref string) (any, error)
}

// SecretVaultProviderFactory registers a provider implementation by provider name.
type SecretVaultProviderFactory struct {
	Provider string
	Create   func(vaultID string, definition VaultDefinition) (SecretVaultProvider, error)
}

func vaultDefinitionForProvider(definition vaultDefinition) VaultDefinition {
	return VaultDefinition{
		Provider: definition.Provider,
		Auth: VaultAuthDefinition{
			Method:     definition.Auth.Method,
			Passphrase: vaultAuthSourceForProvider(definition.Auth.Passphrase),
			Token:      vaultAuthSourceForProvider(definition.Auth.Token),
			Config:     cloneMap(definition.Auth.Config),
		},
		Mapping:  cloneStringMap(definition.Mapping),
		Fallback: vaultFallbackForProvider(definition.Fallback),
	}
}

func vaultFallbackForProvider(fallback []vaultDefinition) []VaultDefinition {
	if len(fallback) == 0 {
		return nil
	}
	result := make([]VaultDefinition, 0, len(fallback))
	for _, definition := range fallback {
		result = append(result, VaultDefinition{
			Provider: definition.Provider,
			Auth: VaultAuthDefinition{
				Method:     definition.Auth.Method,
				Passphrase: vaultAuthSourceForProvider(definition.Auth.Passphrase),
				Token:      vaultAuthSourceForProvider(definition.Auth.Token),
				Config:     cloneMap(definition.Auth.Config),
			},
			Mapping: cloneStringMap(definition.Mapping),
		})
	}
	return result
}

func vaultAuthSourceForProvider(source *vaultAuthSourceFile) *VaultAuthSource {
	if source == nil {
		return nil
	}
	return &VaultAuthSource{From: append([]string(nil), source.From...)}
}

func secretVaultFactoryMap(factories []SecretVaultProviderFactory) map[string]SecretVaultProviderFactory {
	result := map[string]SecretVaultProviderFactory{}
	for _, factory := range factories {
		provider := strings.TrimSpace(factory.Provider)
		if provider == "" || factory.Create == nil {
			continue
		}
		result[provider] = factory
	}
	return result
}

func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	result := make(map[string]any, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}

func cloneStringMap(value map[string]string) map[string]string {
	if value == nil {
		return nil
	}
	result := make(map[string]string, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}

func resolveVaultAuth(vaultID string, definition vaultDefinition, env environment) (VaultAuthConfig, error) {
	method := strings.TrimSpace(definition.Auth.Method)
	if method == "" {
		method = defaultVaultMethod(definition.Provider)
	}

	config := cloneMap(definition.Auth.Config)
	switch method {
	case "iam", "environment":
		return VaultAuthConfig{Method: method, Config: config}, nil
	case "token":
		token, ok := resolveFirstVaultSource(definition.Auth.Token, env)
		if !ok {
			return VaultAuthConfig{}, vaultAuthError(vaultID, definition.Auth.Token)
		}
		return VaultAuthConfig{Method: "token", Token: token, Config: config}, nil
	}

	if definition.Auth.Token != nil && len(definition.Auth.Token.From) > 0 {
		if token, ok := resolveFirstVaultSource(definition.Auth.Token, env); ok {
			return VaultAuthConfig{Method: "token", Token: token, Config: config}, nil
		}
	}

	if definition.Auth.Passphrase != nil && len(definition.Auth.Passphrase.From) > 0 {
		if passphrase, ok := resolveFirstVaultSource(definition.Auth.Passphrase, env); ok {
			return VaultAuthConfig{Method: "passphrase", Passphrase: passphrase, Config: config}, nil
		}
		return VaultAuthConfig{}, vaultAuthError(vaultID, definition.Auth.Passphrase)
	}

	if passphrase, ok := resolveVaultPassphrase(vaultID, env); ok {
		return VaultAuthConfig{Method: "passphrase", Passphrase: passphrase, Config: config}, nil
	}

	return VaultAuthConfig{Method: method, Config: config}, nil
}

func resolveFirstVaultSource(source *vaultAuthSourceFile, env environment) (string, bool) {
	if source == nil {
		return "", false
	}
	for _, candidate := range source.From {
		value, ok := resolveVaultSource(strings.TrimSpace(candidate), env)
		if ok {
			return value, true
		}
	}
	return "", false
}

func resolveVaultSource(source string, env environment) (string, bool) {
	switch {
	case strings.HasPrefix(source, "env:"):
		value, ok := env.Get(strings.TrimPrefix(source, "env:"))
		return strings.TrimSpace(value), ok && strings.TrimSpace(value) != ""
	case strings.HasPrefix(source, "file:"):
		path, err := expandHomePath(strings.TrimPrefix(source, "file:"))
		if err != nil {
			return "", false
		}
		bytes, err := os.ReadFile(path)
		if err != nil {
			return "", false
		}
		value := strings.TrimSpace(string(bytes))
		return value, value != ""
	case strings.HasPrefix(source, "keychain:"):
		return readKeychain(strings.TrimPrefix(source, "keychain:"), env)
	default:
		return "", false
	}
}

func vaultAuthError(vaultID string, source *vaultAuthSourceFile) error {
	sources := []string{}
	if source != nil {
		sources = append(sources, source.From...)
	}
	return fmt.Errorf("cnos: cannot authenticate to vault %q. Tried: %s", vaultID, strings.Join(sources, ", "))
}
