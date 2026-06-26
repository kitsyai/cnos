"""CNOS GCP Secret Manager vault provider."""
from cnos_gcp.provider import GcpSecretManagerProvider, factory

__all__ = ["GcpSecretManagerProvider", "factory"]
