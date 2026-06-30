<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class CnosRuntime
{
    /** @var array<string, array{type:string, ...}> */
    private array $entries = [];
    /** @var array<string, string> */
    private array $sources = [];
    /** @var array<string, mixed> */
    private array $hydratedSecrets = [];
    /** @var array<string, array<string, string>> */
    private array $localVaultCache = [];
    /** @var array<string, string> */
    private array $logicalKeyToVault = [];
    /** @var array<string, bool> */
    private array $runtimeNamespaces = [];
    /** @var array<string, callable> */
    private array $runtimeProviders = [];
    /** @var array<string, SecretVaultProviderFactory> */
    private array $secretFactories = [];
    /** @var array<string, VaultDefinition> */
    private array $vaults = [];

    public function __construct(
        private readonly ServerProjection $projection,
        private readonly array $env,
        private readonly string $secretHome,
        array $factories,
    ) {
        foreach ($factories as $f) {
            if ($f instanceof SecretVaultProviderFactory && $f->provider !== '') {
                $this->secretFactories[$f->provider] = $f;
            }
        }
        $this->vaults = $projection->vaults;
        $this->populateEntries();
        $this->initRuntimeNamespaces();
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    public function projection(): ServerProjection
    {
        return $this->projection;
    }

    /** @return array{mixed, bool} */
    public function read(string $key): array
    {
        return $this->readInternal($key, []);
    }

    public function require(string $key): mixed
    {
        [$value, $found] = $this->read($key);
        if (!$found) {
            throw CnosError::missingKey($key);
        }
        return $value;
    }

    public function readOr(string $key, mixed $fallback = null): mixed
    {
        [$value, $found] = $this->read($key);
        return $found ? $value : $fallback;
    }

    /** @return array{mixed, bool} */
    public function value(string $path): array
    {
        return $this->read($this->toLogicalKey('value', $path));
    }

    /** @return array{mixed, bool} */
    public function secret(string $path): array
    {
        return $this->read($this->toLogicalKey('secret', $path));
    }

    /** @return array{mixed, bool} */
    public function meta(string $path): array
    {
        return $this->read($this->toLogicalKey('meta', $path));
    }

    /** @return array{mixed, bool} */
    public function pub(string $path): array
    {
        return $this->read($this->toLogicalKey('public', $path));
    }

    public function registerSecretVaultProviders(SecretVaultProviderFactory ...$factories): void
    {
        foreach ($factories as $f) {
            if ($f->provider !== '') {
                $this->secretFactories[$f->provider] = $f;
            }
        }
    }

    public function registerRuntimeProvider(string $namespace, callable $provider): void
    {
        if ($namespace === 'process') {
            throw new CnosError('cnos: cannot override built-in runtime namespace "process"');
        }
        if (!isset($this->runtimeNamespaces[$namespace])) {
            throw new CnosError(
                "cnos: cannot register runtime provider for undeclared namespace \"{$namespace}\""
            );
        }
        $this->runtimeProviders[$namespace] = $provider;
    }

    /**
     * Export all non-secret, non-meta keys as KEY=VALUE pairs suitable for env files.
     * Keys become UPPER_SNAKE_CASE.
     *
     * @return array<string, string>
     */
    public function toEnv(bool $includeSecrets = false): array
    {
        $result = [];
        foreach ($this->entries as $key => $_) {
            $ns = $this->namespaceOf($key);
            if ($ns === 'meta') continue;
            if ($ns === 'secret' && !$includeSecrets) continue;
            if ($ns === 'public') continue; // aliases — included via their source keys

            [$value, $found] = $this->read($key);
            if (!$found || $value === null) continue;

            $envKey          = strtoupper(str_replace(['.', '-'], '_', $key));
            $result[$envKey] = is_string($value) ? $value : (string) json_encode($value);
        }
        return $result;
    }

    /**
     * Export all non-secret, non-meta resolved values as an associative array.
     *
     * @return array<string, mixed>
     */
    public function toObject(): array
    {
        $result = [];
        foreach ($this->entries as $key => $_) {
            $ns = $this->namespaceOf($key);
            if ($ns === 'meta' || $ns === 'secret') continue;

            [$value, $found] = $this->read($key);
            if (!$found) continue;
            $result[$key] = $value;
        }
        return $result;
    }

    // -------------------------------------------------------------------------
    // Internal read
    // -------------------------------------------------------------------------

    /** @param string[] $visited */
    private function readInternal(string $key, array $visited): array
    {
        if (!isset($this->entries[$key])) {
            $dot = strpos($key, '.');
            if ($dot !== false) {
                $ns   = substr($key, 0, $dot);
                $rest = substr($key, $dot + 1);
                if (isset($this->runtimeProviders[$ns])) {
                    return [($this->runtimeProviders[$ns])($rest), true];
                }
            }
            return [null, false];
        }

        $entry = $this->entries[$key];

        switch ($entry['type']) {
            case 'alias':
                return $this->readInternal($entry['aliasTo'], $visited);

            case 'secret':
                return $this->readSecret($key, $entry['ref']);

            case 'derived':
                if (in_array($key, $visited, true)) {
                    throw new CnosError(
                        "cnos: recursive derived dependency on \"{$key}\""
                    );
                }
                // Cache non-runtime-dependent formulas
                if (!empty($entry['cached']) && empty($entry['formula']->runtimeRefs)) {
                    return [$entry['cache'], true];
                }
                $nextVisited   = [...$visited, $key];
                $formula       = $entry['formula'];
                $resolver      = fn(string $ref): array => $this->readInternal($ref, $nextVisited);
                $value         = FormulaEvaluator::evaluate($formula, $resolver);
                if (empty($formula->runtimeRefs)) {
                    $this->entries[$key]['cached'] = true;
                    $this->entries[$key]['cache']  = $value;
                }
                return [$value, true];

            default: // 'value'
                return [$entry['value'], true];
        }
    }

    // -------------------------------------------------------------------------
    // Secret resolution
    // -------------------------------------------------------------------------

    /** @return array{mixed, bool} */
    private function readSecret(string $key, SecretReference $ref): array
    {
        if (array_key_exists($key, $this->hydratedSecrets)) {
            return [$this->hydratedSecrets[$key], true];
        }

        $definition = $this->getVaultDefinition($ref);

        if (in_array($definition->provider, ['environment', 'github-secrets'], true)) {
            $value = $this->readEnvSecret($ref, $definition);
            if ($value !== null) {
                $this->hydratedSecrets[$key] = $value;
            }
            return [$value, true];
        }

        if ($definition->provider === 'local') {
            $secrets = $this->getLocalVaultSecrets($ref->vault);
            $value   = $secrets[$ref->ref] ?? null;
            if ($value !== null) {
                $this->hydratedSecrets[$key] = $value;
            }
            return [$value, true];
        }

        // Custom provider — batch-hydrate all refs for this vault
        if (!isset($this->secretFactories[$definition->provider])) {
            throw new CnosError("cnos: unsupported vault provider: {$definition->provider}");
        }
        $this->hydrateCustomVault(
            $ref->vault,
            $definition,
            $this->refsForVault($ref->vault)
        );
        return [$this->hydratedSecrets[$key] ?? null, true];
    }

    private function getVaultDefinition(SecretReference $ref): VaultDefinition
    {
        if (isset($this->vaults[$ref->vault])) {
            $v = $this->vaults[$ref->vault];
            if ($v->provider !== '') {
                return $v;
            }
            return new VaultDefinition(
                provider: $ref->provider ?: 'local',
                auth:     $v->auth,
                mapping:  $v->mapping,
                fallback: $v->fallback,
            );
        }
        return new VaultDefinition(
            provider: $ref->provider ?: 'local',
        );
    }

    private function readEnvSecret(SecretReference $ref, VaultDefinition $definition): ?string
    {
        $val = $this->getEnv($ref->ref);
        if ($val !== null) return $val;

        if ($ref->envVar !== '') {
            $val = $this->getEnv($ref->envVar);
            if ($val !== null) return $val;
        }

        foreach ($definition->mapping as $envVar => $logicalRef) {
            if ($logicalRef === $ref->ref) {
                $val = $this->getEnv($envVar);
                if ($val !== null) return $val;
                break;
            }
        }

        return null;
    }

    /** @return array<string, string> */
    private function getLocalVaultSecrets(string $vaultId): array
    {
        if (isset($this->localVaultCache[$vaultId])) {
            return $this->localVaultCache[$vaultId];
        }

        $secrets = [];
        if ($this->secretHome !== '') {
            $path = $this->secretHome . DIRECTORY_SEPARATOR
                  . 'vaults' . DIRECTORY_SEPARATOR
                  . $vaultId . DIRECTORY_SEPARATOR
                  . 'secrets.json';
            if (is_file($path)) {
                try {
                    $data = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
                    if (is_array($data)) {
                        $secrets = array_map('strval', $data);
                    }
                } catch (\JsonException) {
                    // corrupt file — treat as empty
                }
            }
        }

        $this->localVaultCache[$vaultId] = $secrets;
        return $secrets;
    }

    private function hydrateCustomVault(string $vaultId, VaultDefinition $definition, array $refsByKey): void
    {
        $factory = $this->secretFactories[$definition->provider] ?? null;
        if ($factory === null) return;

        $uniqueRefs = array_unique(array_values($refsByKey));
        sort($uniqueRefs);

        $provider = ($factory->create)($vaultId, $definition);
        $auth     = $this->resolveVaultAuth($vaultId, $definition);
        $provider->authenticate($auth);
        $values = $provider->batchGet($uniqueRefs);

        foreach ($refsByKey as $key => $ref) {
            if (array_key_exists($key, $this->hydratedSecrets)) continue;
            if (isset($values[$ref]) && $values[$ref] !== null) {
                $this->hydratedSecrets[$key] = $values[$ref];
            }
        }
    }

    /** @return array<string, string> key → secret ref */
    private function refsForVault(string $vaultId): array
    {
        $result = [];
        foreach ($this->entries as $key => $entry) {
            if ($entry['type'] !== 'secret') continue;
            if (array_key_exists($key, $this->hydratedSecrets)) continue;
            /** @var SecretReference $ref */
            $ref = $entry['ref'];
            if ($ref->vault === $vaultId) {
                $result[$key] = $ref->ref;
            }
        }
        return $result;
    }

    private function resolveVaultAuth(string $vaultId, VaultDefinition $definition): VaultAuthConfig
    {
        $passphrase = '';
        $token      = '';

        if ($definition->auth->passphrase !== null) {
            foreach ($definition->auth->passphrase->from as $source) {
                if (str_starts_with($source, 'env:')) {
                    $v = $this->getEnv(substr($source, 4));
                    if ($v !== null) { $passphrase = $v; break; }
                }
            }
        }

        if ($definition->auth->token !== null) {
            foreach ($definition->auth->token->from as $source) {
                if (str_starts_with($source, 'env:')) {
                    $v = $this->getEnv(substr($source, 4));
                    if ($v !== null) { $token = $v; break; }
                }
            }
        }

        return new VaultAuthConfig(
            method:     $definition->auth->method,
            passphrase: $passphrase,
            token:      $token,
            config:     $definition->auth->config,
        );
    }

    // -------------------------------------------------------------------------
    // Entry population
    // -------------------------------------------------------------------------

    private function populateEntries(): void
    {
        $workspace = $this->projection->workspace;
        $customNs  = array_flip($this->projection->meta->namespaces);

        // values
        foreach ($this->projection->values as $rawKey => $value) {
            $key = $this->projectionLogicalKey((string) $rawKey, $customNs);
            $this->entries[$key] = ['type' => 'value', 'value' => $value];
            $this->sources[$key] = 'server-projection';
        }

        // derived
        foreach ($this->projection->derived as $rawKey => $formula) {
            $key = $this->projectionLogicalKey((string) $rawKey, $customNs);
            $this->entries[$key] = ['type' => 'derived', 'formula' => $formula];
            $this->sources[$key] = 'server-projection';
        }

        // secret refs
        foreach ($this->projection->secretRefs as $rawKey => $ref) {
            $key = $this->toLogicalKey('secret', (string) $rawKey);
            $this->entries[$key]           = ['type' => 'secret', 'ref' => $ref];
            $this->sources[$key]           = 'server-projection';
            $this->logicalKeyToVault[$key] = $ref->vault;
        }

        // public keys (aliases)
        foreach ($this->projection->publicKeys as $k) {
            $sourceKey = $k;
            if (!isset($this->entries[$sourceKey])) {
                $sourceKey = $this->toLogicalKey('value', $k);
            }
            if (!isset($this->entries[$sourceKey])) continue;
            $publicKey = $this->toLogicalKey('public', $k);
            $this->entries[$publicKey] = ['type' => 'alias', 'aliasTo' => $sourceKey];
            $this->sources[$publicKey] = 'server-projection';
        }

        // meta
        foreach ([
            'meta.profile'      => $this->projection->profile,
            'meta.workspace'    => $workspace,
            'meta.cnos_version' => $this->projection->meta->cnosVersion,
        ] as $key => $value) {
            $this->entries[$key] = ['type' => 'value', 'value' => $value];
            $this->sources[$key] = 'server-projection';
        }
    }

    private function initRuntimeNamespaces(): void
    {
        foreach ($this->projection->runtimeNamespaces as $ns) {
            $this->runtimeNamespaces[$ns] = true;
        }
        if (isset($this->runtimeNamespaces['process'])) {
            $env = $this->env;
            $this->runtimeProviders['process'] = static function (string $path) use ($env): mixed {
                if (str_starts_with($path, 'env.')) {
                    $k = substr($path, 4);
                    return $env[$k] ?? getenv($k) ?: null;
                }
                return match ($path) {
                    'cwd'      => getcwd() ?: '',
                    'platform' => PHP_OS_FAMILY,
                    'pid'      => getmypid(),
                    default    => null,
                };
            };
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private function projectionLogicalKey(string $raw, array $customNs): string
    {
        if (str_starts_with($raw, 'value.') || str_starts_with($raw, 'public.')) {
            return $raw;
        }
        $dot = strpos($raw, '.');
        if ($dot !== false) {
            $first = substr($raw, 0, $dot);
            if (isset($customNs[$first])) {
                return $raw;
            }
        }
        return $this->toLogicalKey('value', $raw);
    }

    private function toLogicalKey(string $namespace, string $path): string
    {
        if (str_starts_with($path, $namespace . '.')) {
            return $path;
        }
        $parts = array_filter(explode('.', $path), fn($p) => $p !== '');
        return $namespace . '.' . implode('.', $parts);
    }

    private function namespaceOf(string $key): string
    {
        $dot = strpos($key, '.');
        return $dot !== false ? substr($key, 0, $dot) : '';
    }

    private function getEnv(string $key): ?string
    {
        if (isset($this->env[$key])) {
            return (string) $this->env[$key];
        }
        $val = getenv($key);
        return $val !== false ? $val : null;
    }
}
