# @kitsy/cnos-webpack

Webpack integration for CNOS.

It resolves CNOS public config during webpack startup, injects `process.env.*` define replacements for promoted public values, and embeds `globalThis.__CNOS_BROWSER_DATA__` for `@kitsy/cnos/browser`.
