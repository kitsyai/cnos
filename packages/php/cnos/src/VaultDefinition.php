<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class VaultDefinition
{
    /** @param VaultDefinition[] $fallback */
    public function __construct(
        public readonly string           $provider = '',
        public readonly VaultAuthDefinition $auth = new VaultAuthDefinition(),
        public readonly array            $mapping = [],
        public readonly array            $fallback = [],
    ) {}

    public static function fromArray(array $d): self
    {
        $fallbackRaw = (array) ($d['fallback'] ?? []);
        return new self(
            provider: (string) ($d['provider'] ?? ''),
            auth:     VaultAuthDefinition::fromArray((array) ($d['auth'] ?? [])),
            mapping:  (array) ($d['mapping'] ?? []),
            fallback: array_map(fn($f) => self::fromArray((array) $f), $fallbackRaw),
        );
    }
}
