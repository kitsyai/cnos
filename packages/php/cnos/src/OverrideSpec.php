<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class OverrideSpec
{
    /**
     * @param string[] $env
     * @param string[] $arg
     * @param string[] $priority
     */
    public function __construct(
        public readonly array   $env = [],
        public readonly array   $arg = [],
        public readonly array   $priority = [],
        public readonly ?string $type = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            env:      array_values((array) ($data['env'] ?? [])),
            arg:      array_values((array) ($data['arg'] ?? [])),
            priority: array_values((array) ($data['priority'] ?? [])),
            type:     isset($data['type']) && is_string($data['type']) ? $data['type'] : null,
        );
    }
}
