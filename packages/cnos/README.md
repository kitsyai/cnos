# @kitsy/cnos

Developer-friendly CNOS runtime assembly. It bundles the core engine plus the official built-in plugins, exposes the main `createCnos(...)` entry point for app code, and re-exports the built-ins under `@kitsy/cnos/plugins/*`.

Current runtime surface includes:
- `createCnos()`
- `@kitsy/cnos/runtime` singleton with `cnos(key)` and `ready()`
- `read`, `require`, `readOr`
- `value`, `secret`, `meta`
- `inspect`
- `toObject`, `toNamespace`
- `toEnv`, `toPublicEnv`

CLI-oriented storage/export rules to be aware of:
- user-defined values and secrets remain private by default
- public/browser exposure comes from `public.promote`
- shell env export comes from explicit `envMapping.explicit`
- local secret material lives outside the repo in encrypted vault storage under `~/.cnos/secrets`

Use `@kitsy/cnos-vite` for Vite projects and `@kitsy/cnos-next` for Next.js projects when you want CNOS public values projected into framework-native env surfaces.
