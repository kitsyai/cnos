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
}
