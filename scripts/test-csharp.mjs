import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

console.log("dotnet test (packages/csharp/Kitsy.Cnos.Tests)");
const result = spawnSync(
  "dotnet",
  ["test", "Kitsy.Cnos.Tests/Kitsy.Cnos.Tests.csproj", "--nologo", "--verbosity", "minimal"],
  {
    cwd: resolve(root, "packages/csharp"),
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
