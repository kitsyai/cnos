import { describe, expect, it } from 'vitest';

import { cliArgEntriesFromArgs, createCliArgsPlugin, parseCliArgs } from '../src/index.js';

describe('@kitsy/cnos-plugin-cli-args', () => {
  it('creates a named plugin', () => {
    expect(createCliArgsPlugin().id).toBe('cli-args');
  });

  it('parses key value args and ignores profile flags', () => {
    expect(
      parseCliArgs([
        '--profile=stage',
        '--value.server.port=8080',
        '--secret.inventory.db.password',
        'top-secret',
      ]),
    ).toEqual([
      {
        key: 'value.server.port',
        value: '8080',
        raw: '--value.server.port=8080',
      },
      {
        key: 'secret.inventory.db.password',
        value: 'top-secret',
        raw: '--secret.inventory.db.password top-secret',
      },
    ]);
  });

  it('converts logical-key args into config entries', () => {
    expect(
      cliArgEntriesFromArgs([
        '--value.server.port=8080',
        '--secret.inventory.db.password',
        'top-secret',
        '--ignored=value',
      ]),
    ).toEqual([
      {
        key: 'value.server.port',
        value: '8080',
        namespace: 'value',
        sourceId: 'cli-args',
        pluginId: '@kitsy/cnos-plugin-cli-args',
        origin: {
          cliArg: '--value.server.port=8080',
        },
      },
      {
        key: 'secret.inventory.db.password',
        value: 'top-secret',
        namespace: 'secret',
        sourceId: 'cli-args',
        pluginId: '@kitsy/cnos-plugin-cli-args',
        origin: {
          cliArg: '--secret.inventory.db.password top-secret',
        },
      },
    ]);
  });
});
