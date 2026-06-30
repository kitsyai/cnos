<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class SecretReference
{
    public string $ref;
    public string $provider;
    public string $vault;
    public string $envVar;

    public function __construct(
        string $ref,
        string $provider = '',
        string $vault = '',
        string $envVar = '',
    ) {
        $this->ref      = $ref;
        $this->provider = $provider;
        $this->vault    = $vault;
        $this->envVar   = $envVar;
    }

    public static function fromArray(array $d): self
    {
        return new self(
            ref: (string) ($d['ref'] ?? ''),
            provider: (string) ($d['provider'] ?? ''),
            vault: (string) ($d['vault'] ?? ''),
            envVar: (string) ($d['envVar'] ?? ''),
        );
    }
}
