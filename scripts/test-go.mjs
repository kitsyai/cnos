import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cache = resolve(root, ".tmp", "go-build");
const workspace = resolve(root, "go.work");
const modules = [
  "packages/go",
  "packages/go/vault/gcpsecretmanager",
  "packages/go/vault/firebasesecrets",
  "packages/go/vault/awssecretsmanager",
  "packages/go/vault/hashicorpvault",
  "packages/go/vault/azurekeyvault",
];

mkdirSync(cache, { recursive: true });

for (const modulePath of modules) {
  console.log(`go test ./... (${modulePath})`);
  const goWork = modulePath === "packages/go" ? "off" : (process.env.GOWORK ?? workspace);
  const result = spawnSync("go", ["test", "./..."], {
    cwd: resolve(root, modulePath),
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE ?? cache,
      GOWORK: goWork,
    },
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
