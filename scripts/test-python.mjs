import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

console.log("pytest (packages/python/cnos)");
const result = spawnSync(
  "python",
  ["-m", "pytest", "tests/", "-q", "--tb=short"],
  {
    cwd: resolve(root, "packages/python/cnos"),
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
