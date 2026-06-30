<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class VaultAuthDefinition
{
    public function __construct(
        public readonly string          $method = '',
        public readonly ?VaultAuthSource $passphrase = null,
        public readonly ?VaultAuthSource $token = null,
        public readonly array           $config = [],
    ) {}

    public static function fromArray(array $d): self
    {
        $pp = $d['passphrase'] ?? null;
        $tk = $d['token'] ?? null;
        return new self(
            method:     (string) ($d['method'] ?? ''),
            passphrase: is_array($pp) ? VaultAuthSource::fromArray($pp) : null,
            token:      is_array($tk) ? VaultAuthSource::fromArray($tk) : null,
            config:     (array) ($d['config'] ?? []),
        );
    }
}
