// Some Workers test runners give `node:fs` without `appendFileSync` and the
// like. A named import of a missing export fails as the module links, which
// vitest's own import rewriting hides, so dist is loaded with an empty `fs`.
import * as module from "node:module";

if (typeof module.register !== "function") {
  console.log(`check-bare-fs: skipped, needs Node 20.6+ (this is ${process.version})`);
  process.exit(0);
}

const hooks = `
const STUB = "baton-check:empty-fs";
export async function resolve(specifier, context, next) {
  if (/^(node:)?fs(\\/promises)?$/.test(specifier)) return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url === STUB) return { format: "module", source: "export default {};", shortCircuit: true };
  return next(url, context);
}`;
module.register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const baton = await import("../dist/index.js");
if (typeof baton.withBaton !== "function") throw new Error("dist/index.js loaded without withBaton");
