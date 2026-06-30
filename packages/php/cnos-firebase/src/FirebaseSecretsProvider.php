<?php

declare(strict_types=1);

namespace Kitsy\Cnos\Firebase;

use Kitsy\Cnos\CnosError;
use Kitsy\Cnos\Gcp\GcpSecretManagerProvider;
use Kitsy\Cnos\SecretVaultProvider;
use Kitsy\Cnos\SecretVaultProviderFactory;
use Kitsy\Cnos\VaultAuthConfig;
use Kitsy\Cnos\VaultDefinition;

/**
 * Firebase secrets are stored in GCP Secret Manager under the Firebase project.
 * This provider delegates to GcpSecretManagerProvider with the Firebase project ID.
 */
class FirebaseSecretsProvider implements SecretVaultProvider
{
    private readonly GcpSecretManagerProvider $delegate;

    public function __construct(
        string $vaultId,
        VaultDefinition $definition,
    ) {
        $cfg        = $definition->auth->config;
        $projectId  = (string) ($cfg['project'] ?? $cfg['projectId'] ?? $cfg['firebaseProjectId'] ?? getenv('FIREBASE_PROJECT_ID') ?: getenv('GOOGLE_CLOUD_PROJECT') ?: '');

        // Build a GCP-compatible definition using the Firebase project ID
        $gcpDef = new VaultDefinition(
            provider: 'gcp-secret-manager',
            auth:     new \Kitsy\Cnos\VaultAuthDefinition(
                method: $definition->auth->method,
                config: array_merge($definition->auth->config, ['project' => $projectId]),
            ),
            mapping:  $definition->mapping,
            fallback: $definition->fallback,
        );

        $this->delegate = new GcpSecretManagerProvider($vaultId, $gcpDef);
    }

    public function authenticate(VaultAuthConfig $auth): void
    {
        $this->delegate->authenticate($auth);
    }

    public function batchGet(array $refs): array
    {
        return $this->delegate->batchGet($refs);
    }

    public function get(string $ref): mixed
    {
        return $this->delegate->get($ref);
    }

    public static function factory(): SecretVaultProviderFactory
    {
        return new SecretVaultProviderFactory(
            provider: 'firebase-secrets',
            create: static fn(string $id, VaultDefinition $def): self => new self($id, $def),
        );
    }
}
