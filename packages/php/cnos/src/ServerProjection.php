<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

class ServerProjection
{
    /**
     * @param array<string, mixed>         $values
     * @param array<string, DerivedFormula> $derived
     * @param array<string, SecretReference> $secretRefs
     * @param array<string, VaultDefinition> $vaults
     * @param string[]                      $publicKeys
     * @param string[]                      $runtimeNamespaces
     * @param array<string, string>         $valueTypes
     */
    public function __construct(
        public readonly int            $version,
        public readonly string         $workspace,
        public readonly string         $profile,
        public readonly string         $resolvedAt,
        public readonly string         $configHash,
        public readonly array          $values,
        public readonly array          $derived,
        public readonly array          $secretRefs,
        public readonly array          $vaults,
        public readonly array          $publicKeys,
        public readonly array          $runtimeNamespaces,
        public readonly ProjectionMeta $meta,
        public readonly array          $valueTypes = [],
    ) {}

    public static function parse(string $json): self
    {
        try {
            $raw = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new CnosError("cnos: parse server projection: {$e->getMessage()}", $e);
        }

        if (!is_array($raw)) {
            throw new CnosError('cnos: invalid server projection payload');
        }

        $version      = $raw['version'] ?? 0;
        $workspace    = (string) ($raw['workspace'] ?? '');
        $profile      = (string) ($raw['profile'] ?? '');
        $resolvedAt   = (string) ($raw['resolvedAt'] ?? '');
        $configHash   = (string) ($raw['configHash'] ?? '');
        $values       = $raw['values'] ?? null;
        $secretRaw    = $raw['secretRefs'] ?? null;
        $publicKeys   = $raw['publicKeys'] ?? null;
        $metaRaw      = (array) ($raw['meta'] ?? []);

        if (
            $version !== 1
            || !$workspace || !$profile || !$resolvedAt || !$configHash
            || $values === null || $secretRaw === null || $publicKeys === null
            || empty($metaRaw['workspace']) || empty($metaRaw['profile']) || empty($metaRaw['cnos_version'])
        ) {
            throw new CnosError('cnos: invalid server projection payload');
        }

        $derived = [];
        foreach ((array) ($raw['derived'] ?? []) as $k => $v) {
            $derived[(string) $k] = DerivedFormula::fromArray((array) $v);
        }

        $vaults = [];
        foreach ((array) ($raw['vaults'] ?? []) as $k => $v) {
            $vaults[(string) $k] = VaultDefinition::fromArray((array) $v);
        }

        $secretRefs = [];
        foreach ((array) $secretRaw as $k => $v) {
            $ref = SecretReference::fromArray((array) $v);
            if (!$ref->vault) {
                $ref->vault = 'default';
            }
            if (!$ref->provider) {
                $ref->provider = isset($vaults[$ref->vault]) && $vaults[$ref->vault]->provider
                    ? $vaults[$ref->vault]->provider
                    : 'local';
            }
            $secretRefs[(string) $k] = $ref;
        }

        return new self(
            version:           $version,
            workspace:         $workspace,
            profile:           $profile,
            resolvedAt:        $resolvedAt,
            configHash:        $configHash,
            values:            (array) $values,
            derived:           $derived,
            secretRefs:        $secretRefs,
            vaults:            $vaults,
            publicKeys:        array_values((array) $publicKeys),
            runtimeNamespaces: array_values((array) ($raw['runtimeNamespaces'] ?? [])),
            meta:              ProjectionMeta::fromArray($metaRaw),
            valueTypes:        (array) ($raw['valueTypes'] ?? []),
        );
    }
}
