import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const root = resolve(import.meta.dirname, "..");

function findMvn() {
  if (process.platform !== "win32") return "mvn";
  // Check local Maven installs under ~/.m2/maven-*/bin/mvn.cmd
  const m2 = join(homedir(), ".m2");
  if (existsSync(m2)) {
    const dirs = readdirSync(m2).filter((d) => d.startsWith("maven-"));
    for (const dir of dirs.sort().reverse()) {
      const cmd = join(m2, dir, "bin", "mvn.cmd");
      if (existsSync(cmd)) return cmd;
    }
  }
  return "mvn.cmd";
}

const mvn = findMvn();
console.log(`mvn test -q (packages/kotlin) [${mvn}]`);
const result = spawnSync(mvn, ["test", "-q"], {
  cwd: resolve(root, "packages/kotlin"),
  shell: true,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
