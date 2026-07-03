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
    /** @var array<string, string> */
    private array $parsedArgs = [];
    /** @var array<string, mixed> */
    private array $fileOverrides = [];

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
        $this->parsedArgs = self::parseCliArgs(array_slice($GLOBALS['argv'] ?? [], 1));
        $this->fileOverrides = self::loadPatchFile(self::detectPatchPath($this->parsedArgs, $this->env));
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
        if (str_starts_with($key, 'value.') && !empty($this->projection->overrides)) {
            $stripped = substr($key, strlen('value.'));
            $spec = $this->projection->overrides[$stripped] ?? null;
            if ($spec !== null) {
                // File override participates as the "cnos" source.
                [$cnosVal, $cnosFound] = $this->fileOrCnos($key);
                return self::applyOverride($spec, $cnosVal, $cnosFound, $this->parsedArgs, $this->env, $key);
            }
        }
        // No OverrideSpec: file then CNOS.
        if (array_key_exists($key, $this->fileOverrides)) {
            return [$this->fileOverrides[$key], true];
        }
        return $this->readInternal($key, []);
    }

    /** @return array{mixed, bool} */
    private function fileOrCnos(string $key): array
    {
        if (array_key_exists($key, $this->fileOverrides)) {
            return [$this->fileOverrides[$key], true];
        }
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

    /**
     * Returns the value at $path as an array/map, parsing string values with json_decode.
     * @return array{mixed, bool}
     */
    public function json(string $path): array
    {
        [$raw, $found] = $this->value($path);
        if (!$found) return [null, false];
        if (is_string($raw)) {
            $parsed = json_decode($raw, true);
            return $parsed !== null ? [$parsed, true] : [null, false];
        }
        return [$raw, true];
    }

    /**
     * Returns the value at $path as a PEM string, normalising literal \n to real newlines.
     * Checks value.* first, then secret.*.
     * @return array{string|null, bool}
     */
    public function pem(string $path): array
    {
        [$raw, $found] = $this->value($path);
        if (!$found) [$raw, $found] = $this->secret($path);
        if (!$found || !is_string($raw)) return [null, false];
        return [str_replace('\\n', "\n", $raw), true];
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

    public function format(string $message): string
    {
        return (string) preg_replace_callback('/\$\{([^}]+)}/', function (array $m): string {
            $key = trim($m[1]);
            if ($key === '') return $m[0];
            [$value, $found] = $this->readInternal($key, []);
            if (!$found) return $m[0];
            return is_string($value) ? $value : (string) json_encode($value);
        }, $message);
    }

    /**
     * Export promoted public keys as env-var pairs for a browser framework.
     *
     * @param string $framework  'vite', 'next', 'react', 'gatsby', 'expo', 'nuxt', 'svelte', 'astro', 'angular', 'webpack'
     * @param string $prefix     explicit prefix override (empty = derive from $framework)
     * @return array<string, string>
     */
    public function toPublicEnv(string $framework = '', string $prefix = ''): array
    {
        $effectivePrefix = $prefix !== '' ? $prefix : self::frameworkPrefix($framework);
        $result          = [];
        foreach ($this->entries as $key => $entry) {
            if (($entry['namespace'] ?? '') !== 'public') continue;
            if (!empty($entry['aliasTo']) && str_starts_with((string) $entry['aliasTo'], 'secret.')) continue;
            [$value, $found] = $this->readInternal($key, []);
            if (!$found || $value === null) continue;
            $shortPath = str_starts_with($key, 'public.') ? substr($key, 7) : $key;
            $baseVar   = $this->fallbackPublicEnvVar($shortPath);
            $envVar    = ($effectivePrefix !== '' && !str_starts_with($baseVar, $effectivePrefix))
                ? $effectivePrefix . $baseVar
                : $baseVar;
            $result[$envVar] = is_string($value) ? $value : (string) json_encode($value);
        }
        return $result;
    }

    public function refreshSecrets(): void
    {
        $savedHydrated   = $this->hydratedSecrets;
        $savedLocalCache = $this->localVaultCache;
        $this->hydratedSecrets  = [];
        $this->localVaultCache  = [];
        try {
            $this->warmSecrets();
        } catch (CnosError $e) {
            $this->hydratedSecrets  = $savedHydrated;
            $this->localVaultCache  = $savedLocalCache;
            throw $e;
        }
    }

    public function refreshSecret(string $path): void
    {
        $key   = $this->toLogicalKey('secret', $path);
        $entry = $this->entries[$key] ?? null;
        if ($entry === null || empty($entry['ref'])) return;

        $hadValue        = array_key_exists($key, $this->hydratedSecrets);
        $savedValue      = $this->hydratedSecrets[$key] ?? null;
        $vaultId         = $this->logicalKeyToVault[$key] ?? null;
        $savedVaultCache = $vaultId !== null ? ($this->localVaultCache[$vaultId] ?? null) : null;

        unset($this->hydratedSecrets[$key]);
        if ($vaultId !== null) unset($this->localVaultCache[$vaultId]);

        try {
            $this->readSecret($key, $entry['ref']);
        } catch (CnosError $e) {
            if ($hadValue) $this->hydratedSecrets[$key] = $savedValue;
            if ($vaultId !== null) {
                if ($savedVaultCache !== null) $this->localVaultCache[$vaultId] = $savedVaultCache;
                else unset($this->localVaultCache[$vaultId]);
            }
            throw $e;
        }
    }

    private function warmSecrets(): void
    {
        $keys = array_keys($this->entries);
        sort($keys);
        foreach ($keys as $key) {
            $entry = $this->entries[$key] ?? null;
            if ($entry === null || empty($entry['ref'])) continue;
            if (($entry['type'] ?? '') !== 'secret') continue;
            $this->readSecret($key, $entry['ref']);
        }
    }

    private static function frameworkPrefix(string $framework): string
    {
        return match ($framework) {
            'vite'    => 'VITE_',
            'next'    => 'NEXT_PUBLIC_',
            'react'   => 'REACT_APP_',
            'gatsby'  => 'GATSBY_',
            'expo'    => 'EXPO_PUBLIC_',
            'nuxt'    => 'NUXT_PUBLIC_',
            'svelte'  => 'PUBLIC_',
            'astro'   => 'PUBLIC_',
            'angular' => 'NG_APP_',
            'webpack' => 'PUBLIC_',
            default   => '',
        };
    }

    private function fallbackPublicEnvVar(string $subPath): string
    {
        $result        = '';
        $lastUnderscore = false;
        for ($i = 0; $i < strlen($subPath); $i++) {
            $c = $subPath[$i];
            if ($c >= 'a' && $c <= 'z') {
                $result        .= strtoupper($c);
                $lastUnderscore = false;
            } elseif (($c >= 'A' && $c <= 'Z') || ($c >= '0' && $c <= '9')) {
                $result        .= $c;
                $lastUnderscore = false;
            } else {
                if (!$lastUnderscore) {
                    $result        .= '_';
                    $lastUnderscore = true;
                }
            }
        }
        return trim($result, '_');
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

    /** @param array<string, string> $parsedArgs @param array<string, mixed> $env */
    private static function detectPatchPath(array $parsedArgs, array $env): ?string
    {
        $flagVal = $parsedArgs['--cnos-patch'] ?? '';
        if ($flagVal !== '') return $flagVal;
        $envVal = $env['CNOS_PATCH_FILE'] ?? '';
        return $envVal !== '' ? $envVal : null;
    }

    /** @return array<string, mixed> */
    private static function loadPatchFile(?string $path): array
    {
        if ($path === null || $path === '') return [];
        $text = @file_get_contents($path);
        if ($text === false) return [];
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if ($ext === 'json') {
            $decoded = @json_decode($text, true);
            return is_array($decoded) ? $decoded : [];
        }
        return self::parsePatchProperties($text);
    }

    /** @return array<string, mixed> */
    private static function parsePatchProperties(string $text): array
    {
        $result = [];
        foreach (explode("\n", $text) as $line) {
            $trimmed = trim($line);
            if ($trimmed === '' || $trimmed[0] === '#' || $trimmed[0] === ';') continue;
            // Bash-style dotenv: "export KEY=value"
            if (str_starts_with($trimmed, 'export ')) {
                $trimmed = trim(substr($trimmed, strlen('export ')));
            }
            $eq = strpos($trimmed, '=');
            if ($eq === false) continue;
            $key = trim(substr($trimmed, 0, $eq));
            $raw = trim(substr($trimmed, $eq + 1));
            if ($key === '') continue;
            // Strip inline comments from unquoted values: KEY=value # comment
            if (!str_starts_with($raw, '"') && !str_starts_with($raw, "'")) {
                if ($raw !== '' && $raw[0] === '#') {
                    $raw = '';
                } else {
                    $ci = strpos($raw, ' #');
                    if ($ci !== false) $raw = trim(substr($raw, 0, $ci));
                }
            }
            if ($raw === '') {
                fwrite(STDERR, "cnos [warn]: patch file key \"$key\" has empty value — skipping\n");
                continue;
            }
            $result[$key] = self::coercePropertyValue($raw);
        }
        return $result;
    }

    private static function coercePropertyValue(string $raw): mixed
    {
        if ($raw === 'true') return true;
        if ($raw === 'false') return false;
        if ($raw === 'null') return null;
        if ((str_starts_with($raw, '"') && str_ends_with($raw, '"')) ||
            (str_starts_with($raw, "'") && str_ends_with($raw, "'"))) {
            return substr($raw, 1, -1);
        }
        if (is_numeric($raw)) return $raw + 0;
        return $raw;
    }

    /** @param string[] $args @return array<string, string> */
    private static function parseCliArgs(array $args): array
    {
        $result = [];
        $i = 0;
        while ($i < count($args)) {
            $arg = $args[$i];
            if (!str_starts_with($arg, '-')) { $i++; continue; }
            $eq = strpos($arg, '=');
            if ($eq !== false) {
                $result[substr($arg, 0, $eq)] = substr($arg, $eq + 1);
                $i++;
                continue;
            }
            if (isset($args[$i + 1]) && !str_starts_with($args[$i + 1], '-')) {
                $result[$arg] = $args[$i + 1];
                $i += 2;
            } else {
                $result[$arg] = 'true';
                $i++;
            }
        }
        return $result;
    }

    /** @return array{mixed, bool} [value, valid] */
    private static function coerceOverrideValue(string $raw, ?string $type): array
    {
        if ($raw === '') return [null, false];
        return match ($type) {
            'number' => is_numeric($raw) ? [$raw + 0, true] : [null, false],
            'boolean' => [in_array($raw, ['true', '1', 'yes'], true), true],
            'object', 'array' => (($v = json_decode($raw, true)) !== null) ? [$v, true] : [null, false],
            default => [$raw, true],
        };
    }

    /** @param array<string, string> $parsedArgs @param array<string, mixed> $env @return array{mixed, bool} */
    private static function applyOverride(
        OverrideSpec $spec,
        mixed $cnosVal,
        bool $cnosFound,
        array $parsedArgs,
        array $env,
        string $key = ''
    ): array {
        $priority = $spec->priority ?: ['arg', 'env', 'cnos'];
        $keyLabel = $key !== '' ? " for \"$key\"" : '';
        foreach ($priority as $source) {
            if ($source === 'arg') {
                foreach ($spec->arg as $flag) {
                    if (!isset($parsedArgs[$flag])) continue;
                    $v = $parsedArgs[$flag];
                    if ($v === '') {
                        fwrite(STDERR, "cnos [warn]: arg \"$flag\" has empty value — skipping override$keyLabel\n");
                        continue;
                    }
                    [$coerced, $valid] = self::coerceOverrideValue($v, $spec->type);
                    if (!$valid) {
                        fwrite(STDERR, "cnos [warn]: arg \"$flag\" value \"$v\" cannot be coerced to " . ($spec->type ?? 'string') . " — skipping override$keyLabel\n");
                        continue;
                    }
                    return [$coerced, true];
                }
            } elseif ($source === 'env') {
                foreach ($spec->env as $varName) {
                    $v = $env[$varName] ?? (getenv($varName) ?: null);
                    if ($v === null || $v === '') continue;
                    [$coerced, $valid] = self::coerceOverrideValue((string) $v, $spec->type);
                    if (!$valid) {
                        fwrite(STDERR, "cnos [warn]: env \"$varName\" value \"$v\" cannot be coerced to " . ($spec->type ?? 'string') . " — skipping override$keyLabel\n");
                        continue;
                    }
                    return [$coerced, true];
                }
            } elseif ($source === 'cnos') {
                if ($cnosFound) return [$cnosVal, true];
            }
        }
        return [$cnosVal, $cnosFound];
    }
}
