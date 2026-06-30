<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class Discover
{
    public static function findProjectionPath(string $workingDir = ''): string
    {
        $dir = $workingDir !== '' ? $workingDir : (getcwd() ?: '');
        $dir = realpath($dir) ?: $dir;

        while (true) {
            $candidate = $dir . DIRECTORY_SEPARATOR . '.cnos-server.json';
            if (is_file($candidate)) {
                return $candidate;
            }
            $parent = dirname($dir);
            if ($parent === $dir) {
                break;
            }
            $dir = $parent;
        }
        return '';
    }
}
