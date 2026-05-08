# Profiles Reference

Profiles are environment overlays such as `local`, `stage`, and `prod`.

## Core Rules

- Profiles are independent of workspaces.
- `local` is the conventional default profile.
- `base` is not a profile name. It is the conventional shared workspace name.
- Profiles can inherit from other profiles.

## Activation Order

The active profile can come from:

1. explicit CLI/runtime option
2. repo-local persisted selection such as `.cnos-workspace.yml`
3. manifest default

The exact precedence is defined by manifest/profile resolution code and the CLI help surface.

## Typical CLI Flows

```bash
cnos profile create stage
cnos profile list
cnos profile use stage
cnos diff local stage
```

For an isolated profile with no inherited fallback:

```bash
cnos profile create isolated --no-inherit
```

## Agent Guidance

- Profile logic lives in `packages/core/src/profiles/`.
- Workspace and profile behavior should not be conflated in code or docs.
- If docs or examples use `base` where a profile should be named, fix them.
