# @kitsy/cnos-vite

Vite integration for CNOS.

It resolves CNOS public config during Vite config evaluation and injects the exported values into `import.meta.env.*` and `process.env.*` define replacements using the Vite public convention.
