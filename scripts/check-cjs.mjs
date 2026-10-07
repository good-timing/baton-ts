// Jest and other CommonJS runners load dist/index.cjs through a require() that
// cannot load ES modules. Node can since 22.12, which hides an ESM-only
// dependency from every other check, so that ability is switched off here.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const strictRequire = process.features.require_module ? ["--no-experimental-require-module"] : [];
execFileSync(process.execPath, [...strictRequire, "-e", "require('./dist/index.cjs')"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
});
