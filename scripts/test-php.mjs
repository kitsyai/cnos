import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const phpDir = resolve(root, "packages/php/cnos");

// Install dependencies if vendor/ is absent
if (!existsSync(resolve(phpDir, "vendor"))) {
  console.log("composer install (packages/php/cnos)");
  const install = spawnSync("composer", ["install", "--no-interaction", "--quiet"], {
    cwd: phpDir,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

console.log("phpunit tests/ (packages/php/cnos)");
const result = spawnSync(
  "vendor/bin/phpunit",
  ["tests/", "--no-progress"],
  {
    cwd: phpDir,
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
