import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const docsRoot = path.join(root, 'docs');
const manifestPath = path.join(root, 'manifest.yml');
const helpRegistryPath = path.join(root, '..', 'cli', 'src', 'cli', 'helpRegistry.ts');

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

async function walkMdxFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkMdxFiles(fullPath);
      }
      if (entry.isFile() && entry.name.endsWith('.mdx')) {
        return [fullPath];
      }
      return [];
    }),
  );

  return files.flat();
}

function parseFrontmatter(source, filePath) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error(`Missing frontmatter in ${filePath}`);
  }

  const lines = match[1].split(/\r?\n/);
  const fields = new Map();

  for (const line of lines) {
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (fieldMatch) {
      fields.set(fieldMatch[1], fieldMatch[2].trim().replace(/^['"]|['"]$/g, ''));
    }
  }

  for (const key of ['title', 'description']) {
    if (!fields.get(key)) {
      throw new Error(`Missing required frontmatter field "${key}" in ${filePath}`);
    }
  }
}

function extractManifestPaths(source) {
  return Array.from(
    source.matchAll(/^\s*-\s*path:\s*([A-Za-z0-9/_-]+)\s*$/gm),
    (match) => match[1],
  );
}

function extractRelativeLinks(source) {
  return Array.from(
    source.matchAll(/\[[^\]]+\]\((\.{1,2}\/[^)#]+(?:\.mdx)?)\)/g),
    (match) => match[1],
  );
}

function extractTopLevelCliCommandIds(source) {
  const ids = Array.from(source.matchAll(/id:\s*'([^']+)'/g), (match) => match[1]);
  const excluded = new Set(['vite', 'next']);

  return ids.filter((id) => !id.includes(' ') && !excluded.has(id));
}

async function main() {
  const [manifestSource, helpRegistrySource, mdxFiles] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(helpRegistryPath, 'utf8'),
    walkMdxFiles(docsRoot),
  ]);

  const manifestDocPaths = extractManifestPaths(manifestSource);
  const manifestFileSet = new Set(manifestDocPaths.map((docPath) => normalizeSlashes(path.join(docsRoot, `${docPath}.mdx`))));
  const allowedOrphans = new Set([normalizeSlashes(path.join(docsRoot, 'index.mdx'))]);

  for (const manifestDocPath of manifestDocPaths) {
    const target = path.join(docsRoot, `${manifestDocPath}.mdx`);
    await fs.access(target).catch(() => {
      throw new Error(`Manifest path "${manifestDocPath}" is missing file ${target}`);
    });
  }

  const topLevelCliCommandIds = extractTopLevelCliCommandIds(helpRegistrySource);
  for (const commandId of topLevelCliCommandIds) {
    const cliDocPath = normalizeSlashes(path.join(docsRoot, 'cli', `${commandId}.mdx`));
    await fs.access(cliDocPath).catch(() => {
      throw new Error(`Missing CLI docs page for top-level command "${commandId}": ${cliDocPath}`);
    });
  }

  for (const filePath of mdxFiles) {
    const normalized = normalizeSlashes(filePath);
    const source = await fs.readFile(filePath, 'utf8');
    parseFrontmatter(source, normalized);

    if (!manifestFileSet.has(normalized) && !allowedOrphans.has(normalized)) {
      throw new Error(`Orphan docs file not referenced by manifest: ${normalized}`);
    }

    const relativeLinks = extractRelativeLinks(source);
    for (const relativeLink of relativeLinks) {
      const targetPath = path.resolve(path.dirname(filePath), relativeLink);
      await fs.access(targetPath).catch(() => {
        throw new Error(`Broken internal link in ${normalized}: ${relativeLink}`);
      });
    }
  }

  console.log(`Validated ${mdxFiles.length} docs pages against ${manifestDocPaths.length} manifest entries.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
