<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

/**
 * Static facade for the default CNOS runtime.
 *
 * Usage:
 *   Cnos::ready();                       // bootstrap from env / .cnos-server.json
 *   [$port, $ok] = Cnos::value('server.port');
 *   $pass = Cnos::require('secret.db.password');
 */
class Cnos
{
    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------

    public static function ready(?LoaderOptions $options = null): void
    {
        Loader::ready($options);
    }

    public static function load(?LoaderOptions $options = null): CnosRuntime
    {
        return Loader::load($options);
    }

    public static function setDefaultRuntime(CnosRuntime $runtime): void
    {
        Loader::setDefaultRuntime($runtime);
    }

    public static function defaultRuntime(): CnosRuntime
    {
        return Loader::defaultRuntime();
    }

    public static function resetDefaultRuntime(): void
    {
        Loader::resetDefaultRuntime();
    }

    // -------------------------------------------------------------------------
    // Read API — all return [value, found]
    // -------------------------------------------------------------------------

    /** @return array{mixed, bool} */
    public static function read(string $key): array
    {
        return Loader::defaultRuntime()->read($key);
    }

    public static function require(string $key): mixed
    {
        return Loader::defaultRuntime()->require($key);
    }

    public static function readOr(string $key, mixed $fallback = null): mixed
    {
        return Loader::defaultRuntime()->readOr($key, $fallback);
    }

    /** @return array{mixed, bool} */
    public static function value(string $path): array
    {
        return Loader::defaultRuntime()->value($path);
    }

    /** @return array{mixed, bool} */
    public static function secret(string $path): array
    {
        return Loader::defaultRuntime()->secret($path);
    }

    /** @return array{mixed, bool} */
    public static function meta(string $path): array
    {
        return Loader::defaultRuntime()->meta($path);
    }

    /** @return array{mixed, bool} */
    public static function pub(string $path): array
    {
        return Loader::defaultRuntime()->pub($path);
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    public static function registerSecretVaultProviders(SecretVaultProviderFactory ...$factories): void
    {
        Loader::defaultRuntime()->registerSecretVaultProviders(...$factories);
    }

    public static function registerRuntimeProvider(string $namespace, callable $provider): void
    {
        Loader::defaultRuntime()->registerRuntimeProvider($namespace, $provider);
    }

    // -------------------------------------------------------------------------
    // Exports
    // -------------------------------------------------------------------------

    /** @return array<string, string> */
    public static function toEnv(bool $includeSecrets = false): array
    {
        return Loader::defaultRuntime()->toEnv($includeSecrets);
    }

    /** @return array<string, mixed> */
    public static function toObject(): array
    {
        return Loader::defaultRuntime()->toObject();
    }

    /** @return array<string, string> */
    public static function toPublicEnv(string $framework = '', string $prefix = ''): array
    {
        return Loader::defaultRuntime()->toPublicEnv($framework, $prefix);
    }

    public static function format(string $message): string
    {
        return Loader::defaultRuntime()->format($message);
    }

    public static function refreshSecrets(): void
    {
        Loader::defaultRuntime()->refreshSecrets();
    }

    public static function refreshSecret(string $path): void
    {
        Loader::defaultRuntime()->refreshSecret($path);
    }
}
