<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class VaultAuthSource
{
    /** @param string[] $from */
    public function __construct(public readonly array $from) {}

    public static function fromArray(array $d): self
    {
        return new self(from: array_values((array) ($d['from'] ?? [])));
    }
}
