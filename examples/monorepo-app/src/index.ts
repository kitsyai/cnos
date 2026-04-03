import { createCnos } from '@kitsy/cnos';

export async function runMonorepoAppExample() {
  const runtime = await createCnos({
    entries: [
      { key: 'workspace.name', value: 'cnos-monorepo' },
      { key: 'apps.web.port', value: 4000 },
    ],
    manifest: {
      name: 'monorepo-app',
    },
  });

  return runtime.inspect();
}
