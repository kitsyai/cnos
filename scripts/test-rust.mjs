import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

console.log("cargo test -p cnos-tests (packages/rust)");
const result = spawnSync("cargo", ["test", "-p", "cnos-tests"], {
  cwd: resolve(root, "packages/rust"),
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
