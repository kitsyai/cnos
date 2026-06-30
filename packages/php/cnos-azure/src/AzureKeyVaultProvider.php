<?php

declare(strict_types=1);

namespace Kitsy\Cnos\Azure;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\ClientException;
use Kitsy\Cnos\CnosError;
use Kitsy\Cnos\SecretVaultProvider;
use Kitsy\Cnos\SecretVaultProviderFactory;
use Kitsy\Cnos\VaultAuthConfig;
use Kitsy\Cnos\VaultDefinition;

class AzureKeyVaultProvider implements SecretVaultProvider
{
    private string $vaultUrl;
    private string $accessToken = '';
    private ?Client $http;

    public function __construct(
        private readonly string $vaultId,
        VaultDefinition $definition,
        ?Client $http = null,
    ) {
        $this->vaultUrl = rtrim((string) ($definition->auth->config['vaultUrl'] ?? ''), '/');
        $this->http     = $http;
    }

    public function authenticate(VaultAuthConfig $auth): void
    {
        if ($this->http === null) {
            $this->http = new Client(['timeout' => 10.0]);
        }

        $cfg        = $auth->config;
        $tenantId   = (string) ($cfg['tenantId'] ?? getenv('AZURE_TENANT_ID') ?: '');
        $clientId   = (string) ($cfg['clientId'] ?? getenv('AZURE_CLIENT_ID') ?: '');
        $clientSec  = $auth->token !== '' ? $auth->token : (string) (getenv('AZURE_CLIENT_SECRET') ?: '');

        if ($tenantId !== '' && $clientId !== '' && $clientSec !== '') {
            $this->accessToken = $this->getServicePrincipalToken($tenantId, $clientId, $clientSec);
            return;
        }

        // Managed Identity (IMDS)
        $msiEndpoint = getenv('IDENTITY_ENDPOINT') ?: getenv('MSI_ENDPOINT') ?: '';
        if ($msiEndpoint !== '') {
            $this->accessToken = $this->getManagedIdentityToken($msiEndpoint);
            return;
        }

        throw new CnosError(
            "cnos-azure: no credentials found. "
            . "Set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET, "
            . "or run inside an Azure managed-identity environment."
        );
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

    private function getOne(string $name): ?string
    {
        if ($this->vaultUrl === '') {
            throw new CnosError("cnos-azure: vaultUrl is required in vault auth config");
        }
        $url = "{$this->vaultUrl}/secrets/{$name}?api-version=7.4";
        try {
            $resp = $this->http->get($url, [
                'headers' => ['Authorization' => "Bearer {$this->accessToken}"],
            ]);
            $body = json_decode((string) $resp->getBody(), true);
            return isset($body['value']) ? (string) $body['value'] : null;
        } catch (ClientException $e) {
            if ($e->getResponse()->getStatusCode() === 404) return null;
            throw new CnosError("cnos-azure: Key Vault error for \"{$name}\": {$e->getMessage()}", $e);
        }
    }

    private function getServicePrincipalToken(
        string $tenantId, string $clientId, string $clientSecret
    ): string {
        $url  = "https://login.microsoftonline.com/{$tenantId}/oauth2/v2.0/token";
        $resp = $this->http->post($url, [
            'form_params' => [
                'grant_type'    => 'client_credentials',
                'client_id'     => $clientId,
                'client_secret' => $clientSecret,
                'scope'         => 'https://vault.azure.net/.default',
            ],
        ]);
        $body = json_decode((string) $resp->getBody(), true);
        return (string) ($body['access_token'] ?? '');
    }

    private function getManagedIdentityToken(string $endpoint): string
    {
        $resp = $this->http->get($endpoint, [
            'query'   => ['resource' => 'https://vault.azure.net', 'api-version' => '2019-08-01'],
            'headers' => ['Metadata' => 'true'],
        ]);
        $body = json_decode((string) $resp->getBody(), true);
        return (string) ($body['access_token'] ?? '');
    }

    public static function factory(?Client $http = null): SecretVaultProviderFactory
    {
        return new SecretVaultProviderFactory(
            provider: 'azure-key-vault',
            create: static fn(string $id, VaultDefinition $def): self => new self($id, $def, $http),
        );
    }
}
