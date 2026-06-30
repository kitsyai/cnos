<?php

declare(strict_types=1);

namespace Kitsy\Cnos\Aws;

use Kitsy\Cnos\CnosError;
use Kitsy\Cnos\SecretVaultProvider;
use Kitsy\Cnos\SecretVaultProviderFactory;
use Kitsy\Cnos\VaultAuthConfig;
use Kitsy\Cnos\VaultDefinition;

class AwsSecretsManagerProvider implements SecretVaultProvider
{
    private readonly array $config;
    private ?object $client;

    public function __construct(
        private readonly string $vaultId,
        VaultDefinition $definition,
        ?object $client = null,
    ) {
        $cfg          = $definition->auth->config;
        $this->config = [
            'region'       => (string) ($cfg['region'] ?? ''),
            'endpoint'     => (string) ($cfg['endpoint'] ?? ''),
            'versionId'    => (string) ($cfg['versionId'] ?? $cfg['version'] ?? ''),
            'versionStage' => (string) ($cfg['versionStage'] ?? ''),
        ];
        $this->client = $client;
    }

    public function authenticate(VaultAuthConfig $auth): void
    {
        if ($this->client !== null) return;
        $this->client = $this->buildClient();
    }

    private function buildClient(): object
    {
        if (!class_exists(\Aws\SecretsManager\SecretsManagerClient::class)) {
            throw new CnosError('cnos-aws: aws/aws-sdk-php is required. Run: composer require aws/aws-sdk-php');
        }
        $args = ['version' => 'latest', 'region' => $this->config['region'] ?: 'us-east-1'];
        if ($this->config['endpoint'] !== '') {
            $args['endpoint'] = $this->config['endpoint'];
        }
        return new \Aws\SecretsManager\SecretsManagerClient($args);
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
        try {
            $args = ['SecretId' => $ref];
            if ($this->config['versionId'] !== '')    $args['VersionId']    = $this->config['versionId'];
            if ($this->config['versionStage'] !== '') $args['VersionStage'] = $this->config['versionStage'];

            $resp = $this->client->getSecretValue($args);
            return isset($resp['SecretString']) ? (string) $resp['SecretString'] : null;
        } catch (\Aws\Exception\AwsException $e) {
            if ($e->getAwsErrorCode() === 'ResourceNotFoundException') return null;
            throw new CnosError("cnos-aws: {$e->getMessage()}", $e);
        }
    }

    public static function factory(?object $client = null): SecretVaultProviderFactory
    {
        return new SecretVaultProviderFactory(
            provider: 'aws-secrets-manager',
            create: static fn(string $id, VaultDefinition $def): self => new self($id, $def, $client),
        );
    }
}
