// Package firebasesecrets provides a compiled-in CNOS provider for Firebase Secrets.
package firebasesecrets

import (
	cnos "github.com/kitsyai/cnos/packages/go"
	"github.com/kitsyai/cnos/packages/go/vault/gcpsecretmanager"
)

const Provider = "firebase-secrets"

// Client is the narrow Secret Manager client surface used by this provider.
type Client = gcpsecretmanager.Client

// Option configures the Firebase Secrets provider factory.
type Option = gcpsecretmanager.Option

// WithClient injects a client, primarily for tests or custom transports.
func WithClient(client Client) Option {
	return gcpsecretmanager.WithClient(client)
}

// Factory returns a CNOS provider factory for Firebase Secrets.
func Factory(configure ...Option) cnos.SecretVaultProviderFactory {
	return cnos.SecretVaultProviderFactory{
		Provider: Provider,
		Create: func(vaultID string, definition cnos.VaultDefinition) (cnos.SecretVaultProvider, error) {
			return New(vaultID, definition, configure...)
		},
	}
}

// New creates a Firebase Secrets CNOS provider instance.
func New(vaultID string, definition cnos.VaultDefinition, configure ...Option) (cnos.SecretVaultProvider, error) {
	definition.Provider = gcpsecretmanager.Provider
	provider, err := gcpsecretmanager.New(vaultID, definition, configure...)
	if err != nil {
		return nil, err
	}
	return &firebaseProvider{delegate: provider}, nil
}

type firebaseProvider struct {
	delegate cnos.SecretVaultProvider
}

func (provider *firebaseProvider) Authenticate(auth cnos.VaultAuthConfig) error {
	return provider.delegate.Authenticate(auth)
}

func (provider *firebaseProvider) BatchGet(refs []string) (map[string]any, error) {
	return provider.delegate.BatchGet(refs)
}

func (provider *firebaseProvider) Get(ref string) (any, error) {
	return provider.delegate.Get(ref)
}
