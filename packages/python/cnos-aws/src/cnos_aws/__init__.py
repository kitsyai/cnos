"""CNOS AWS Secrets Manager vault provider."""
from cnos_aws.provider import AwsSecretsManagerProvider, factory

__all__ = ["AwsSecretsManagerProvider", "factory"]
