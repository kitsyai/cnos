#!/usr/bin/env node

import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repoRoot);

const ecosystems = new Set([
  'node',
  'go',
  'java',
  'kotlin',
  'python',
  'rust',
  'csharp',
  'php',
]);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`  -> ${message}`);
}

function step(message) {
  console.log(`\n>> ${message}`);
}

function run(command, args, options = {}) {
  const useWindowsShell =
    process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: useWindowsShell,
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    fail(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.capture && result.stderr) {
      process.stderr.write(result.stderr);
    }
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

function git(...args) {
  return run('git', args, { capture: true });
}

function walk(root, predicate) {
  const results = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'target') {
      continue;
    }
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      results.push(...walk(path, predicate));
    } else if (predicate(path)) {
      results.push(path);
    }
  }
  return results;
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function write(path, content) {
  writeFileSync(path, content, 'utf8');
}

function replace(path, pattern, replacement) {
  const before = read(path);
  const after = before.replace(pattern, replacement);
  if (after !== before) {
    write(path, after);
    return true;
  }
  return false;
}

function parseVersion(value, source) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    fail(`Could not read a semantic version from ${source}: '${value}'`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left, left);
  const b = parseVersion(right, right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

function bumpVersion(current, request) {
  if (/^\d+\.\d+\.\d+$/.test(request)) {
    if (compareVersions(request, current) < 0) {
      fail(`Target version ${request} is older than current ${current}`);
    }
    return request;
  }
  const [major, minor, patch] = parseVersion(current, current);
  switch (request) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      fail(`Version must be X.Y.Z or major|minor|patch (got '${request}')`);
  }
}

function versionFrom(path, pattern, description) {
  const match = pattern.exec(read(path));
  if (!match) {
    fail(`Could not detect current version from ${description}`);
  }
  return match[1];
}

function latestTagVersion(pattern, prefix) {
  const tag = git('tag', '--list', pattern, '--sort=-v:refname')
    .split(/\r?\n/)
    .find(Boolean);
  if (!tag) {
    return undefined;
  }
  const version = tag.slice(prefix.length);
  parseVersion(version, tag);
  return version;
}

function detectCurrentVersion(ecosystem) {
  switch (ecosystem) {
    case 'node':
      return JSON.parse(read('packages/cnos/package.json')).version;
    case 'go':
      return (
        latestTagVersion('packages/go/v[0-9]*', 'packages/go/v') ??
        latestTagVersion('v[0-9]*', 'v')
      );
    case 'java':
      return versionFrom(
        'packages/java/pom.xml',
        /<revision>(\d+\.\d+\.\d+)<\/revision>/,
        'packages/java/pom.xml',
      );
    case 'kotlin':
      return versionFrom(
        'packages/kotlin/pom.xml',
        /<revision>(\d+\.\d+\.\d+)<\/revision>/,
        'packages/kotlin/pom.xml',
      );
    case 'python':
      return versionFrom(
        'packages/python/cnos/pyproject.toml',
        /^version = "(\d+\.\d+\.\d+)"$/m,
        'packages/python/cnos/pyproject.toml',
      );
    case 'rust':
      return versionFrom(
        'packages/rust/cnos/Cargo.toml',
        /^version = "(\d+\.\d+\.\d+)"$/m,
        'packages/rust/cnos/Cargo.toml',
      );
    case 'csharp':
      return versionFrom(
        'packages/csharp/Kitsy.Cnos/Kitsy.Cnos.csproj',
        /<Version>(\d+\.\d+\.\d+)<\/Version>/,
        'packages/csharp/Kitsy.Cnos/Kitsy.Cnos.csproj',
      );
    case 'php':
      return (
        latestTagVersion('release/php/v[0-9]*', 'release/php/v') ??
        latestTagVersion('v[0-9]*', 'v')
      );
    default:
      fail(`Unsupported ecosystem '${ecosystem}'`);
  }
}

function ensureClean(message) {
  if (git('status', '--porcelain')) {
    fail(message);
  }
}

function runChecks(ecosystem) {
  const node = process.execPath;
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  if (ecosystem === 'node') {
    run(pnpm, ['-r', 'typecheck']);
    run(pnpm, ['-r', 'test']);
    run(pnpm, ['publish:check']);
    return;
  }
  run(node, [`scripts/test-${ecosystem}.mjs`]);
}

function bumpNode(oldVersion, newVersion) {
  const packageFiles = walk('packages', (path) => path.endsWith('package.json'));
  for (const path of packageFiles) {
    const manifest = JSON.parse(read(path));
    let changed = false;
    if (manifest.version === oldVersion) {
      manifest.version = newVersion;
      changed = true;
    }
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      if (!manifest[section]) {
        continue;
      }
      for (const [name, value] of Object.entries(manifest[section])) {
        if (value === `^${oldVersion}`) {
          manifest[section][name] = `^${newVersion}`;
          changed = true;
        }
      }
    }
    if (changed) {
      write(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
}

function bumpGo(newVersion) {
  const moduleFiles = walk('packages/go', (path) => path.endsWith('go.mod'));
  for (const path of moduleFiles) {
    if (relative('packages/go', path) === 'go.mod') {
      continue;
    }
    replace(
      path,
      /(github\.com\/kitsyai\/cnos\/packages\/go) v\d+\.\d+\.\d+/g,
      `$1 v${newVersion}`,
    );
  }
}

function bumpPython(oldVersion, newVersion) {
  const files = walk('packages/python', (path) => path.endsWith('pyproject.toml'));
  const escaped = oldVersion.replaceAll('.', '\\.');
  for (const path of files) {
    replace(
      path,
      new RegExp(`version = "${escaped}"`, 'g'),
      `version = "${newVersion}"`,
    );
    replace(
      path,
      new RegExp(`kitsy-cnos>=${escaped}`, 'g'),
      `kitsy-cnos>=${newVersion}`,
    );
  }
}

function bumpRust(oldVersion, newVersion) {
  const files = walk('packages/rust', (path) => path.endsWith('Cargo.toml'));
  const escaped = oldVersion.replaceAll('.', '\\.');
  for (const path of files) {
    replace(
      path,
      new RegExp(`version = "${escaped}"`, 'g'),
      `version = "${newVersion}"`,
    );
  }
}

function bumpCsharp(oldVersion, newVersion) {
  const files = walk('packages/csharp', (path) => path.endsWith('.csproj'));
  const escaped = oldVersion.replaceAll('.', '\\.');
  for (const path of files) {
    replace(path, new RegExp(escaped, 'g'), newVersion);
  }
}

function bumpFiles(ecosystem, oldVersion, newVersion) {
  switch (ecosystem) {
    case 'node':
      bumpNode(oldVersion, newVersion);
      return ['packages'];
    case 'go':
      bumpGo(newVersion);
      return ['packages/go'];
    case 'java':
      replace(
        'packages/java/pom.xml',
        `<revision>${oldVersion}</revision>`,
        `<revision>${newVersion}</revision>`,
      );
      return ['packages/java'];
    case 'kotlin':
      replace(
        'packages/kotlin/pom.xml',
        `<revision>${oldVersion}</revision>`,
        `<revision>${newVersion}</revision>`,
      );
      return ['packages/kotlin'];
    case 'python':
      bumpPython(oldVersion, newVersion);
      return ['packages/python'];
    case 'rust':
      bumpRust(oldVersion, newVersion);
      return ['packages/rust'];
    case 'csharp':
      bumpCsharp(oldVersion, newVersion);
      return ['packages/csharp'];
    case 'php':
      return [];
    default:
      fail(`Unsupported ecosystem '${ecosystem}'`);
  }
}

function usage() {
  console.log(`Usage: release-part <ecosystem> <major|minor|patch|X.Y.Z> [--skip-tests]

Ecosystems: node, go, java, kotlin, python, rust, csharp, php

Examples:
  pnpm release:part node minor
  bash ./scripts/release-part.sh go 1.18.0
  .\\scripts\\release-part.ps1 java patch

The command bumps only the selected ecosystem and pushes the immutable
release/<ecosystem>/vX.Y.Z tag that triggers only its publish workflow.`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}
const options = new Set(args.filter((arg) => arg.startsWith('--')));
for (const option of options) {
  if (option !== '--skip-tests') {
    fail(`Unknown option '${option}'`);
  }
}
const positional = args.filter((arg) => !arg.startsWith('-'));
if (positional.length !== 2) {
  usage();
  process.exit(1);
}

const [ecosystem, requestedVersion] = positional;
if (!ecosystems.has(ecosystem)) {
  fail(`Ecosystem must be one of: ${[...ecosystems].join(', ')}`);
}

step('Pre-flight checks');
const branch = git('branch', '--show-current');
if (branch !== 'main') {
  fail(`Must be on main (currently on '${branch}')`);
}
ensureClean('Working tree is dirty; commit or stash changes first');
run('git', ['fetch', '--quiet', 'origin', 'main', '--tags']);
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  fail('Local main is not in sync with origin/main');
}
info('main is clean and synchronized with origin');

const currentVersion = detectCurrentVersion(ecosystem);
if (!currentVersion) {
  fail(`Could not detect the current ${ecosystem} version from manifests or tags`);
}
const newVersion = bumpVersion(currentVersion, requestedVersion);
const tag = `release/${ecosystem}/v${newVersion}`;
if (git('tag', '--list', tag)) {
  fail(`Tag ${tag} already exists; release tags are immutable`);
}
console.log(`\nPartial release: ${ecosystem} ${currentVersion} -> ${newVersion}`);
console.log(`Publish trigger: ${tag}`);

step(`${ecosystem} checks`);
if (options.has('--skip-tests')) {
  info('Skipped (--skip-tests)');
} else {
  runChecks(ecosystem);
  info('Checks passed');
}
ensureClean('Checks changed tracked files; inspect and commit those changes separately');

step(`Bumping ${ecosystem} to ${newVersion}`);
const stagePaths = bumpFiles(ecosystem, currentVersion, newVersion);
const changes = git('status', '--porcelain');
if (changes) {
  run('git', ['add', '--', ...stagePaths]);
  run('git', [
    'commit',
    '-m',
    `chore(release): bump ${ecosystem} to ${newVersion}`,
  ]);
  info('Version bump committed');
} else {
  info('No version-bearing files changed; the scoped tag is the release version');
}

step(`Tagging ${tag}`);
run('git', ['tag', '-a', tag, '-m', `${ecosystem} version ${newVersion}`]);

step('Publishing release commit and tag');
run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', tag]);
info(`${tag} pushed; only the ${ecosystem} publish workflow will run`);
