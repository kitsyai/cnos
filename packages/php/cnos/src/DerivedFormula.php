<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class DerivedFormula
{
    /** @param string[] $deps @param string[] $runtimeRefs */
    public function __construct(
        public readonly string $expr,
        public readonly array  $deps,
        public readonly array  $runtimeRefs,
    ) {}

    public static function fromArray(array $d): self
    {
        return new self(
            expr: (string) ($d['expr'] ?? ''),
            deps: array_values((array) ($d['deps'] ?? [])),
            runtimeRefs: array_values((array) ($d['runtimeRefs'] ?? [])),
        );
    }
}
