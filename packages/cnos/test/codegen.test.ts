import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { generateCodegenContent, watchSchema, writeCodegenOutput } from '../src/internal.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createCodegenFixture(schemaLines?: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-codegen-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos'), { recursive: true });
  const lines = ['version: 1', 'project:', '  name: codegen-fixture'];

  if (schemaLines && schemaLines.length > 0) {
    lines.push('schema:');
    lines.push(...schemaLines);
  }

  await writeFile(path.join(root, '.cnos', 'cnos.yml'), lines.join('\n'));
  return root;
}

describe('@kitsy/cnos codegen', () => {
  it('maps schema rules into typed declarations', () => {
    const generated = generateCodegenContent(
      {
        version: 1,
        project: { name: 'demo' },
        workspaces: {
          global: {
            enabled: false,
            allowWrite: false,
          },
          items: {},
        },
        profiles: {
          default: 'base',
          resolveFrom: ['cli.profile', 'env.CNOS_PROFILE', 'default'],
        },
        plugins: {
          loaders: [],
          resolver: 'profile-aware',
          validators: [],
          exporters: [],
          inspectors: [],
        },
        sources: {},
        resolution: {
          precedence: [],
          arrayPolicy: 'replace',
        },
        envMapping: {
          explicit: {},
        },
        public: {
          promote: [],
          frameworks: {},
        },
        namespaces: {},
        vaults: {},
        writePolicy: {
          define: {
            defaultProfile: 'base',
            targets: {
              value: 'local',
              secret: 'local',
            },
          },
        },
        schema: {
          'value.server.port': {
            type: 'number',
            required: true,
          },
          'value.server.host': {
            type: 'string',
            default: '127.0.0.1',
          },
          'secret.db.password': {
            type: 'string',
            required: true,
          },
          'value.flags': {
            type: 'array',
          },
        },
      },
      '.cnos/cnos.yml',
    );

    expect(generated.typesContent).toContain('"server.port": number;');
    expect(generated.typesContent).toContain('"server.host": string;');
    expect(generated.typesContent).toContain('"db.password": string;');
    expect(generated.typesContent).toContain('"flags"?: unknown[];');
    expect(generated.runtimeContent).toContain('type CnosCreateOptions');
  });

  it(
    'writes default output and compiles generated runtime wrapper',
    async () => {
    const root = await createCodegenFixture([
      '  value.server.port:',
      '    type: number',
      '    required: true',
      '  secret.db.password:',
      '    type: string',
      '    required: true',
    ]);

    const result = await writeCodegenOutput({ root });

    expect(result.typesPath).toBe(path.join(root, '.cnos', 'types', 'cnos.d.ts'));
    expect(await readFile(result.typesPath, 'utf8')).toContain('export interface TypedCnosRuntime');

    const compileRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-codegen-compile-'));
    fixtureRoots.push(compileRoot);
    await mkdir(path.join(compileRoot, 'node_modules', '@kitsy', 'cnos'), { recursive: true });
    await writeFile(
      path.join(compileRoot, 'node_modules', '@kitsy', 'cnos', 'index.d.ts'),
      [
        'export interface CnosRuntime {',
        '  value(path: string): unknown;',
        '  secret(path: string): unknown;',
        '  require(key: string): unknown;',
        '}',
        'export interface CnosCreateOptions {',
        '  root?: string;',
        '}',
        'export function createCnos(options?: CnosCreateOptions): Promise<CnosRuntime>;',
      ].join('\n'),
      'utf8',
    );
    await mkdir(path.join(compileRoot, '.cnos', 'types'), { recursive: true });
    await writeFile(path.join(compileRoot, '.cnos', 'types', 'cnos.d.ts'), await readFile(result.typesPath, 'utf8'));
    await writeFile(
      path.join(compileRoot, '.cnos', 'types', 'runtime.ts'),
      await readFile(result.runtimePath, 'utf8'),
    );
    await writeFile(
      path.join(compileRoot, 'consumer.ts'),
      [
        'import { createCnos } from "./.cnos/types/runtime";',
        'async function main() {',
        '  const cnos = await createCnos();',
        '  const port = cnos.value("server.port");',
        '  const password = cnos.secret("db.password");',
        '  return { port, password };',
        '}',
        'void main();',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(compileRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Node',
            strict: true,
            noEmit: true,
          },
          include: ['consumer.ts', '.cnos/types/runtime.ts', '.cnos/types/cnos.d.ts'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const configPath = ts.findConfigFile(compileRoot, ts.sys.fileExists, 'tsconfig.json');
    expect(configPath).toBeTruthy();
    const configFile = ts.readConfigFile(configPath!, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, compileRoot);
    const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
    const diagnostics = ts.getPreEmitDiagnostics(program);

      expect(diagnostics).toHaveLength(0);
    },
    15000,
  );

  it('falls back gracefully when schema is missing and regenerates on change in watch mode', async () => {
    const root = await createCodegenFixture();

    const emptyResult = await writeCodegenOutput({ root });
    expect(emptyResult.hasSchema).toBe(false);
    expect(await readFile(emptyResult.typesPath, 'utf8')).toContain('Hint: add a schema section');

    let writes = 0;
    const watcher = await watchSchema({
      root,
      debounceMs: 25,
      onWrite() {
        writes += 1;
      },
    });

    try {
      await writeFile(
        path.join(root, '.cnos', 'cnos.yml'),
        [
          'version: 1',
          'project:',
          '  name: codegen-fixture',
          'schema:',
          '  value.app.name:',
          '    type: string',
          '    required: true',
        ].join('\n'),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(writes).toBeGreaterThanOrEqual(2);
      expect(await readFile(path.join(root, '.cnos', 'types', 'cnos.d.ts'), 'utf8')).toContain('"app.name": string;');
    } finally {
      watcher.close();
    }
  });
});
