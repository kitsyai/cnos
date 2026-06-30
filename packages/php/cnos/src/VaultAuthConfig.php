<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class VaultAuthConfig
{
    public function __construct(
        public readonly string $method = '',
        public readonly string $passphrase = '',
        public readonly string $token = '',
        public readonly array  $config = [],
    ) {}
}
