<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class ProjectionMeta
{
    /** @param string[] $namespaces */
    public function __construct(
        public readonly string $workspace   = '',
        public readonly string $profile     = '',
        public readonly string $cnosVersion = '',
        public readonly array  $namespaces  = [],
    ) {}

    public static function fromArray(array $d): self
    {
        return new self(
            workspace:   (string) ($d['workspace'] ?? ''),
            profile:     (string) ($d['profile'] ?? ''),
            cnosVersion: (string) ($d['cnos_version'] ?? ''),
            namespaces:  array_values((array) ($d['namespaces'] ?? [])),
        );
    }
}
