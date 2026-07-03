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

    public static function resetDefaultRuntime(): void
    {
        self::$defaultRuntime = null;
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
        $argv       = array_slice($GLOBALS['argv'] ?? [], 1);
        $parsedArgv = self::parseArgv($argv);

        // 5. Explicit runtime projection path: --cnos-projection or CNOS_SERVER_PROJECTION_PATH
        // Checked before file auto-discovery so it always wins over .cnos-server.json on disk.
        $runtimeProj = $parsedArgv['--cnos-projection'] ?? '';
        if ($runtimeProj === '') {
            $runtimeProj = self::envValue('CNOS_SERVER_PROJECTION_PATH', $env) ?? '';
        }
        if ($runtimeProj !== '') {
            $resolved = self::resolvePathFromWorkingDir($opts->workingDir, $runtimeProj);
            return self::newRuntime(self::readFile($resolved), $env, $secretHome, $factories);
        }

        $path = Discover::findProjectionPath($opts->workingDir);
        if ($path !== '') {
            return self::newRuntime(self::readFile($path), $env, $secretHome, $factories);
        }

        // 6. Dynamic mode: CNOS_DYNAMIC=1 or --cnos-dynamic — suppress projection-not-found.
        $isDynamic = ($parsedArgv['--cnos-dynamic'] ?? '') === 'true';
        if (!$isDynamic) {
            $dynEnv = strtolower(self::envValue('CNOS_DYNAMIC', $env) ?? '');
            $isDynamic = in_array($dynEnv, ['1', 'true', 'yes'], true);
        }
        if ($isDynamic) {
            return self::newDynamicRuntime($env, $secretHome, $factories);
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

    private static function newDynamicRuntime(
        array $env,
        string $secretHome,
        array $factories,
    ): CnosRuntime {
        $projection = new ServerProjection(
            version:           1,
            workspace:         'base',
            profile:           '',
            resolvedAt:        '',
            configHash:        '',
            values:            [],
            derived:           [],
            secretRefs:        [],
            vaults:            [],
            publicKeys:        [],
            runtimeNamespaces: ['process'],
            meta:              new ProjectionMeta(workspace: 'base', profile: '', cnosVersion: 'dynamic'),
        );
        return new CnosRuntime($projection, $env, $secretHome, $factories);
    }

    private static function resolvePathFromWorkingDir(?string $workingDir, string $path): string
    {
        if ($path === '') return $path;
        // Absolute path: Unix /... or Windows C:\... / C:/...
        if ($path[0] === '/' || $path[0] === '\\' || (strlen($path) >= 2 && $path[1] === ':')) {
            return $path;
        }
        $base = ($workingDir !== null && $workingDir !== '') ? $workingDir : (getcwd() ?: '');
        return $base . DIRECTORY_SEPARATOR . $path;
    }

    /** @param string[] $argv @return array<string, string> */
    private static function parseArgv(array $argv): array
    {
        $result = [];
        $i = 0;
        while ($i < count($argv)) {
            $arg = $argv[$i];
            if (!str_starts_with($arg, '-')) { $i++; continue; }
            $eq = strpos($arg, '=');
            if ($eq !== false) {
                $result[substr($arg, 0, $eq)] = substr($arg, $eq + 1);
                $i++;
                continue;
            }
            if ($i + 1 < count($argv) && !str_starts_with($argv[$i + 1], '-')) {
                $result[$arg] = $argv[$i + 1];
                $i += 2;
            } else {
                $result[$arg] = 'true';
                $i++;
            }
        }
        return $result;
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
