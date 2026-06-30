<?php

declare(strict_types=1);

namespace Kitsy\Cnos\HashiCorp;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\ClientException;
use Kitsy\Cnos\CnosError;
use Kitsy\Cnos\SecretVaultProvider;
use Kitsy\Cnos\SecretVaultProviderFactory;
use Kitsy\Cnos\VaultAuthConfig;
use Kitsy\Cnos\VaultDefinition;

class HashiCorpVaultProvider implements SecretVaultProvider
{
    private readonly string $address;
    private readonly string $mount;
    private string $token = '';
    private readonly Client $http;

    public function __construct(
        private readonly string $vaultId,
        VaultDefinition $definition,
        ?Client $http = null,
    ) {
        $cfg           = $definition->auth->config;
        $this->address = rtrim((string) ($cfg['address'] ?? $cfg['url'] ?? 'http://127.0.0.1:8200'), '/');
        $this->mount   = (string) ($cfg['mount'] ?? 'secret');
        $this->http    = $http ?? new Client(['timeout' => 10.0]);
    }

    public function authenticate(VaultAuthConfig $auth): void
    {
        if ($auth->token !== '') {
            $this->token = $auth->token;
            return;
        }
        $envToken = getenv('VAULT_TOKEN') ?: '';
        if ($envToken !== '') {
            $this->token = $envToken;
            return;
        }
        throw new CnosError("cnos-hashicorp: no Vault token provided");
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

    private function getOne(string $ref): mixed
    {
        // Support "path#field" notation
        $field = null;
        if (($hashPos = strpos($ref, '#')) !== false) {
            $field = substr($ref, $hashPos + 1);
            $ref   = substr($ref, 0, $hashPos);
        }

        $url = "{$this->address}/v1/{$this->mount}/data/{$ref}";
        try {
            $resp = $this->http->get($url, [
                'headers' => ['X-Vault-Token' => $this->token],
            ]);
            $body  = json_decode((string) $resp->getBody(), true);
            $data  = $body['data']['data'] ?? null;
            if (!is_array($data)) return null;
            $key   = $field ?? 'value';
            return $data[$key] ?? null;
        } catch (ClientException $e) {
            if ($e->getResponse()->getStatusCode() === 404) return null;
            throw new CnosError(
                "cnos-hashicorp: Vault error for \"{$ref}\": {$e->getMessage()}", $e
            );
        }
    }

    public static function factory(?Client $http = null): SecretVaultProviderFactory
    {
        return new SecretVaultProviderFactory(
            provider: 'hashicorp',
            create: static fn(string $id, VaultDefinition $def): self => new self($id, $def, $http),
        );
    }
}
