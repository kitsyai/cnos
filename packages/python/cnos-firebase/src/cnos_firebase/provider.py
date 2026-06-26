"""Firebase Secrets CNOS vault provider.

This is a thin wrapper over GcpSecretManagerProvider. Firebase projects use
the same GCP Secret Manager API; the only difference is the provider name
reported to the CNOS runtime ("firebase-secrets" instead of "gcp-secret-manager").

All authentication and secret-fetching logic is delegated entirely to
GcpSecretManagerProvider.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from cnos.types import (
    SecretVaultProvider,
    SecretVaultProviderFactory,
    VaultAuthConfig,
    VaultDefinition,
)
from cnos_gcp.provider import GcpSecretManagerProvider

PROVIDER_NAME = "firebase-secrets"


class FirebaseSecretsProvider(SecretVaultProvider):
    """Delegates entirely to GcpSecretManagerProvider; swaps the provider name."""

    def __init__(
        self,
        vault_id: str,
        definition: VaultDefinition,
        client: Any = None,
    ) -> None:
        self._vault_id = vault_id
        self._definition = definition
        self._delegate = GcpSecretManagerProvider(vault_id, definition, client=client)

    def authenticate(self, auth: VaultAuthConfig) -> None:
        self._delegate.authenticate(auth)

    def batch_get(self, refs: List[str]) -> Dict[str, Any]:
        return self._delegate.batch_get(refs)

    def get(self, ref: str) -> Optional[Any]:
        return self._delegate.get(ref)


def factory(client: Any = None) -> SecretVaultProviderFactory:
    """Return a SecretVaultProviderFactory for Firebase Secrets.

    Pass client= to inject a mock GCP Secret Manager client for tests.
    """
    def create(vault_id: str, definition: VaultDefinition) -> FirebaseSecretsProvider:
        return FirebaseSecretsProvider(vault_id, definition, client=client)

    return SecretVaultProviderFactory(provider=PROVIDER_NAME, create=create)
