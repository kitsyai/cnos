<?php

declare(strict_types=1);

namespace Kitsy\Cnos\Gcp;

use Google\Cloud\SecretManager\V1\SecretManagerServiceClient;
use Kitsy\Cnos\CnosError;
use Kitsy\Cnos\SecretVaultProvider;
use Kitsy\Cnos\SecretVaultProviderFactory;
use Kitsy\Cnos\VaultAuthConfig;
use Kitsy\Cnos\VaultDefinition;

class GcpSecretManagerProvider implements SecretVaultProvider
{
    private ?SecretManagerServiceClient $client;
    private readonly string $projectId;
    private readonly string $version;

    public function __construct(
        private readonly string $vaultId,
        VaultDefinition $definition,
        ?SecretManagerServiceClient $client = null,
    ) {
        $cfg            = $definition->auth->config;
        $this->projectId = (string) ($cfg['project'] ?? $cfg['projectId'] ?? getenv('GOOGLE_CLOUD_PROJECT') ?: '');
        $this->version   = (string) ($cfg['version'] ?? 'latest');
        $this->client    = $client;
    }

    public function authenticate(VaultAuthConfig $auth): void
    {
        if ($this->client !== null) return;

        if (!class_exists(SecretManagerServiceClient::class)) {
            throw new CnosError(
                'cnos-gcp: google/cloud-secret-manager is required. '
                . 'Run: composer require google/cloud-secret-manager'
            );
        }
        if ($this->projectId === '') {
            throw new CnosError(
                "cnos-gcp: project ID is required. Set GOOGLE_CLOUD_PROJECT or vault auth config.project"
            );
        }
        $this->client = new SecretManagerServiceClient();
    }

    public function batchGet(array $refs): array
    {
        $result = [];
        foreach ($refs as $ref) {
            $val = $this->getOne((string) $ref);
            if ($val !== null) {
                $result[$ref] = $val;
            }
        }
        return $result;
    }

    public function get(string $ref): mixed
    {
        return $this->getOne($ref);
    }

    private function getOne(string $ref): ?string
    {
        // ref format: "secret-name" or "projects/…/secrets/name/versions/latest"
        if (!str_starts_with($ref, 'projects/')) {
            $ref = "projects/{$this->projectId}/secrets/{$ref}/versions/{$this->version}";
        }
        try {
            $response = $this->client->accessSecretVersion($ref);
            return $response->getPayload()?->getData() ?? null;
        } catch (\Google\ApiCore\ApiException $e) {
            if ($e->getStatus() === 'NOT_FOUND') return null;
            throw new CnosError("cnos-gcp: Secret Manager error for \"{$ref}\": {$e->getMessage()}", $e);
        }
    }

    public static function factory(?SecretManagerServiceClient $client = null): SecretVaultProviderFactory
    {
        return new SecretVaultProviderFactory(
            provider: 'gcp-secret-manager',
            create: static fn(string $id, VaultDefinition $def): self => new self($id, $def, $client),
        );
    }
}
