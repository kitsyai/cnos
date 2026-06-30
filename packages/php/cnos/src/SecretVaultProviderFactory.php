<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class SecretVaultProviderFactory
{
    /**
     * @param \Closure(string, VaultDefinition): SecretVaultProvider $create
     */
    public function __construct(
        public readonly string  $provider,
        public readonly \Closure $create,
    ) {}
}
