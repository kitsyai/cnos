<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

interface SecretVaultProvider
{
    public function authenticate(VaultAuthConfig $auth): void;

    /**
     * @param  string[]             $refs
     * @return array<string, mixed>
     */
    public function batchGet(array $refs): array;

    public function get(string $ref): mixed;
}
