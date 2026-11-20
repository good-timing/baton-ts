// Installs the packed package the way a vendor does, for each MCP SDK and zod
// version below, and checks the tool list, a call, a report and a refused
// report. A vendor zod that differs from Baton's gets Baton its own nested
// copy, which the repo's own tests, sharing one zod, cannot reproduce.
// Needs the network; run before a release: `npm run check:zod-copies`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SDKS = ["1.29.0", "1.32.2", "2.0.0"];
const ZODS = { 1: ["3.25.76", "4.2.0", "4.3.6", "4.4.2", "4.6.7"], 2: ["4.1.13", "4.2.0", "4.3.6", "4.4.2", "4.6.7"] };

const root = fileURLToPath(new URL("../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "baton-zod-copies-"));

const check = (v1, [serverModule, clientModule, memoryModule]) => `
const { McpServer } = await import("${serverModule}");
const { Client } = await import("${clientModule}");
const { InMemoryTransport } = await import("${memoryModule}");
const { withBaton } = await import("@goodtiming/baton-sdk");
const { z } = await import("zod");
const shape = (s) => (${v1} ? s : z.object(s));
const events = [];
const sink = { write: async (e) => { events.push(e.event_type); }, flush: async () => {}, aclose: async () => {} };
const server = new McpServer({ name: "check", version: "1.0.0" });
server.registerTool("lookup", { inputSchema: shape({ name: z.string(), tags: z.record(z.string(), z.unknown()).optional() }) }, async ({ name }) => ({ content: [{ type: "text", text: "found " + name }] }));
const { annotationToolName } = withBaton(server, { vendorId: "check", vendorDisplayName: "Check", reportMode: "on", consentToken: "ct", sink });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "c", version: "1" });
await client.connect(b);
const tools = await client.listTools().then(
  (listed) => listed.tools,
  (err) => { console.log("FAILED list: " + err.message); process.exit(0); },
);
const report = tools.find((t) => t.name === annotationToolName);
const lookup = tools.find((t) => t.name === "lookup");
const call = await client.callTool({ name: "lookup", arguments: { name: "x", user_goal: "find x" } });
const ok = await client.callTool({ name: annotationToolName, arguments: { user_goal: "g", what_happened: "w", context: { a: 1 } } });
const bad = await client.callTool({ name: annotationToolName, arguments: { user_goal: 5 } });
await new Promise((resolve) => setTimeout(resolve, 100));
const failed = [
  !("what_happened" in (report?.inputSchema?.properties ?? {})) && "list",
  !("user_goal" in (lookup?.inputSchema?.properties ?? {})) && "user_goal",
  call.content[0].text !== "found x" && "call",
  ok.content[0].text !== '{"ok":true}' && "report",
  !(bad.isError && /Invalid arguments for tool/.test(bad.content[0].text)) && "refusal",
  !events.includes("annotation") && "event",
].filter(Boolean);
console.log(failed.length ? "FAILED " + failed.join(",") : "ok");
process.exit(0);
`;

let failures = 0;
try {
  execFileSync("npm", ["pack", "--pack-destination", work], { cwd: root, stdio: "ignore" });
  const packed = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (packed === undefined) throw new Error(`npm pack wrote no tarball to ${work}`);
  const tarball = join(work, packed);
  for (const sdk of SDKS) {
    const v1 = sdk.startsWith("1.");
    for (const zod of ZODS[v1 ? 1 : 2]) {
      const dir = mkdtempSync(join(work, `sdk-${sdk}-zod-${zod}-`));
      const sdkDeps = v1
        ? { "@modelcontextprotocol/sdk": sdk }
        : { "@modelcontextprotocol/server": sdk, "@modelcontextprotocol/client": sdk };
      const modules = v1
        ? ["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/client/index.js", "@modelcontextprotocol/sdk/inMemory.js"]
        : ["@modelcontextprotocol/server", "@modelcontextprotocol/client", "@modelcontextprotocol/server"];
      const dependencies = { "@goodtiming/baton-sdk": `file:${tarball}`, ...sdkDeps, zod };
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", private: true, dependencies }));
      writeFileSync(join(dir, "check.mjs"), check(v1, modules));
      let result;
      try {
        execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: "ignore", timeout: 300_000 });
        result = execFileSync(process.execPath, ["check.mjs"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 })
          .trim()
          .split("\n")
          .at(-1);
      } catch (err) {
        result = `FAILED ${err.stderr?.trim().split("\n").at(-1) || String(err.message).split("\n")[0]}`;
      }
      if (result !== "ok") failures += 1;
      // Whether this row tests the case it exists for: Baton on a zod of its own.
      const copies = existsSync(join(dir, "node_modules/@goodtiming/baton-sdk/node_modules/zod")) ? "two zods" : "one zod ";
      console.log(`sdk ${sdk.padEnd(6)} zod ${zod.padEnd(8)} ${copies} ${result}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
