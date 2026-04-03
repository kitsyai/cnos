import { describe, expect, it } from 'vitest';

import { printJson } from '../src/format/printJson.js';
import { runInit } from '../src/commands/init.js';

describe('@kitsy/cnos-cli', () => {
  it('keeps command stubs reachable', () => {
    expect(runInit()).toContain('scaffolded');
  });

  it('formats json output', () => {
    expect(printJson({ ok: true })).toContain('"ok": true');
  });
});
