<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class Loader
{
    private const PROJECTION_ENV_VAR = '__CNOS_PROJECTION__';

    private static ?CnosRuntime $defaultRuntime = null;

    public static function defaultRuntime(): CnosRuntime
    {
        if (self::$defaultRuntime === null) {
            throw CnosError::runtimeNotReady();
        }
        return self::$defaultRuntime;
    }

    public static function setDefaultRuntime(CnosRuntime $runtime): void
    {
        self::$defaultRuntime = $runtime;
    }

    public static function load(?LoaderOptions $options = null): CnosRuntime
    {
        $opts       = $options ?? new LoaderOptions();
        $env        = $opts->environment;
        $secretHome = $opts->secretHome !== '' ? $opts->secretHome : self::resolveSecretHome($env);
        $factories  = $opts->secretVaultProviders;

        // 1. Explicit projection data
        if ($opts->projectionData !== null) {
            return self::newRuntime($opts->projectionData, $env, $secretHome, $factories);
        }

        // 2. Explicit projection path
        if ($opts->projectionPath !== '') {
            return self::newRuntime(self::readFile($opts->projectionPath), $env, $secretHome, $factories);
        }

        // 3. __CNOS_PROJECTION__ env var
        $proj = self::envValue(self::PROJECTION_ENV_VAR, $env);
        if ($proj !== null && $proj !== '') {
            return self::newRuntime($proj, $env, $secretHome, $factories);
        }

        // 4. .cnos-server.json file discovery
        $path = Discover::findProjectionPath($opts->workingDir);
        if ($path !== '') {
            return self::newRuntime(self::readFile($path), $env, $secretHome, $factories);
        }

        throw CnosError::projectionNotFound();
    }

    public static function loadProjection(string $data, ?LoaderOptions $options = null): CnosRuntime
    {
        $opts = $options ?? new LoaderOptions();
        $opts->projectionData = $data;
        return self::load($opts);
    }

    public static function loadProjectionFile(string $path, ?LoaderOptions $options = null): CnosRuntime
    {
        $opts = $options ?? new LoaderOptions();
        $opts->projectionPath = $path;
        return self::load($opts);
    }

    public static function ready(?LoaderOptions $options = null): void
    {
        if (self::$defaultRuntime !== null) {
            if ($options !== null && $options->secretVaultProviders !== []) {
                self::$defaultRuntime->registerSecretVaultProviders(...$options->secretVaultProviders);
            }
            return;
        }

        self::$defaultRuntime = self::load($options);
    }

    // -------------------------------------------------------------------------

    private static function newRuntime(
        string $data,
        array $env,
        string $secretHome,
        array $factories,
    ): CnosRuntime {
        $projection = ServerProjection::parse($data);
        return new CnosRuntime($projection, $env, $secretHome, $factories);
    }

    private static function readFile(string $path): string
    {
        $data = file_get_contents($path);
        if ($data === false) {
            throw new CnosError("cnos: read projection file \"{$path}\": failed");
        }
        return $data;
    }

    /** @param array<string, string> $env */
    private static function envValue(string $key, array $env): ?string
    {
        if (isset($env[$key])) return (string) $env[$key];
        $val = getenv($key);
        return $val !== false ? $val : null;
    }

    /** @param array<string, string> $env */
    private static function resolveSecretHome(array $env): string
    {
        $h = self::envValue('CNOS_SECRET_HOME', $env);
        if ($h !== null && $h !== '') return $h;

        $home = self::envValue('HOME', $env) ?? self::envValue('USERPROFILE', $env) ?? '';
        return $home !== '' ? $home . DIRECTORY_SEPARATOR . '.cnos' : '';
    }
}
