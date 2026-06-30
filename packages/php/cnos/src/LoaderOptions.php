<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class LoaderOptions
{
    public string  $projectionPath = '';
    public ?string $projectionData = null;
    public string  $workingDir     = '';
    /** @var array<string, string> */
    public array   $environment    = [];
    public string  $secretHome     = '';
    /** @var SecretVaultProviderFactory[] */
    public array   $secretVaultProviders = [];
}
