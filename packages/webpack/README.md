# @kitsy/cnos-webpack

Webpack integration for CNOS.

It resolves CNOS public config during webpack startup, injects `process.env.*` define replacements for promoted public values, and embeds `globalThis.__CNOS_BROWSER_DATA__` for `@kitsy/cnos/browser`.

Webpack uses an empty public env prefix by default. Configure `public.frameworks.webpack` in your manifest or pass `prefix` to the plugin if you want names such as `APP_*`.

Recommended plugin order:
- `new CnosWebpackPlugin(...)`
- `new HtmlWebpackPlugin(...)`
- `new MiniCssExtractPlugin(...)`
- `new CopyPlugin(...)`
- `new ESLintPlugin(...)`

If your webpack config is CommonJS, load CNOS via dynamic `import()` inside an async `module.exports = async () => ...` factory. If webpack loads your config as ESM, `require(...)` is not available.
