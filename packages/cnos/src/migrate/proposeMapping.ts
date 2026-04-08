export interface EnvMappingProposal {
  envVar: string;
  namespace: 'value' | 'secret';
  logicalPath: string;
  logicalKey: string;
  public: boolean;
  framework?: 'vite' | 'next';
}

const SECRET_TOKENS = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN'];

function normalizeSegments(value: string): string[] {
  return value
    .split('_')
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
}

function isSecretEnvVar(value: string): boolean {
  return SECRET_TOKENS.some((token) => value.includes(`_${token}`) || value.endsWith(token));
}

export function proposeMapping(envVar: string): EnvMappingProposal {
  const framework =
    envVar.startsWith('VITE_') ? 'vite' : envVar.startsWith('NEXT_PUBLIC_') ? 'next' : undefined;
  const strippedEnvVar =
    framework === 'vite'
      ? envVar.slice('VITE_'.length)
      : framework === 'next'
        ? envVar.slice('NEXT_PUBLIC_'.length)
        : envVar;
  const namespace: 'value' | 'secret' = isSecretEnvVar(strippedEnvVar) && !framework ? 'secret' : 'value';
  const segments = normalizeSegments(strippedEnvVar);
  const logicalPath = segments.join('.');

  return {
    envVar,
    namespace,
    logicalPath,
    logicalKey: `${namespace}.${logicalPath}`,
    public: Boolean(framework),
    ...(framework
      ? {
          framework,
        }
      : {}),
  };
}
