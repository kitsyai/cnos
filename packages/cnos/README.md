# @kitsy/cnos

Developer-friendly CNOS runtime assembly. It prewires the official v1 plugins on top of `@kitsy/cnos-core`, exposes the main `createCnos(...)` entry point for app code, and re-exports first-party helpers such as `@kitsy/cnos/plugin/vite` and `@kitsy/cnos/plugin/next`.

Use `@kitsy/cnos/plugin/vite` for Vite projects and `@kitsy/cnos/plugin/next` for Next.js projects when you want CNOS public values projected into framework-native env surfaces.
