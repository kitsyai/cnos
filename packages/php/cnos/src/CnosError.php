<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class CnosError extends \RuntimeException
{
    public function __construct(string $message, ?\Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
    }

    public static function missingKey(string $key): self
    {
        return new self("cnos: key not found: {$key}");
    }

    public static function runtimeNotReady(): self
    {
        return new self(
            "cnos: runtime not ready. Call Cnos::ready() or Cnos::load() first."
        );
    }

    public static function projectionNotFound(): self
    {
        return new self(
            "cnos: server projection not found. Run 'cnos project export' to generate .cnos-server.json."
        );
    }
}
