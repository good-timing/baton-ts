/** `serve()` end to end: the MCP SDK's own client, over Streamable HTTP, to a
 * plain HTTP handler that answers MCP with its own code and `serve()` around
 * it. Two users in two organizations: one whose audience withholds results
 * and hides a tool, and reports on for both. */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import { Client, type Principal } from "../../src/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

const KEY = "baton_pk_" + "a".repeat(43);
const COLLECTOR = "https://ingest.example.com";
const DSN = `https://${KEY}@ingest.example.com/ten_655b084e118b43f88992ee6357fcc23c/srv_sunny`;
const SETTINGS = {
  version: 7,
  audiences: [
    { id: "enterprise", match: { label: ["enterprise"] }, capture: { results: "off" }, overlay: "ov_1" },
    { id: "everyone", match: {}, capture: {} },
  ],
  overlays: { ov_1: { actions: [{ target: { tool: "legacy_book" }, remove: true }] } },
};
const USERS: Record<string, Principal> = {
  alice: { principalId: "alice", organization: { organizationId: "bigco", labels: ["enterprise"] } },
  bob: { principalId: "bob", organization: { organizationId: "smallco" } },
};
const TOOLS = [
  { name: "find_slots", inputSchema: { type: "object", properties: { day: { type: "string" } } } },
  { name: "legacy_book", inputSchema: { type: "object", properties: {} } },
];

/** The vendor's own MCP code: message in, answer out. */
function vendorDispatch(message: any): unknown {
  if (message.id === undefined) return null;
  const answer = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return answer({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "Sunny", version: "1" },
        instructions: "Book slots at Sunny.",
      });
    case "tools/list":
      return answer({ tools: TOOLS });
    case "tools/call":
      return answer({ content: [{ type: "text", text: `slots for ${message.params.arguments.day}: 9am` }] });
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
}

const events: Record<string, any>[] = [];
let server: http.Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.aclose();
  await new Promise((resolve) => server?.close(resolve));
  events.length = 0;
  vi.unstubAllGlobals();
});

it("serves two users their own settings, and records both", async () => {
  // The collector is stubbed; the vendor's own server is real.
  const realFetch = globalThis.fetch;
  let settingsReads = 0;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    if (!href.startsWith(COLLECTOR)) return realFetch(url, init);
    if (href.includes("/v0/settings")) {
      settingsReads += 1;
      return new Response(JSON.stringify(SETTINGS), { status: 200 });
    }
    const body = JSON.parse(init!.body as string) as { events?: Record<string, unknown>[] };
    events.push(...(body.events ?? [body]));
    return new Response(null, { status: 202 });
  });
  const baton = new Client({ dsn: DSN, settings: "console", vendorDisplayName: "Sunny" });
  client = baton;
  await vi.waitFor(() => expect(settingsReads).toBe(1));
  await new Promise((resolve) => setImmediate(resolve));

  server = http.createServer((req, res) => {
    // A stateless server: no stream to open with GET, no session to end with DELETE.
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const user = USERS[String(req.headers.authorization).replace("Bearer ", "")]!;
      void baton
        .serve(JSON.parse(body), vendorDispatch, { principal: user, headers: req.headers as Record<string, string> })
        .then((answer) => {
          if (answer === null) {
            res.writeHead(202).end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);

  const seen: Record<string, { tools: string[]; instructions: string | undefined; legacy: any }> = {};
  for (const name of ["alice", "bob"]) {
    const mcp = new McpClient({ name: "claude-code", version: "2" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${name}` } },
    });
    // The SDK's own transport, typed without `exactOptionalPropertyTypes`.
    await mcp.connect(transport as Parameters<McpClient["connect"]>[0]);
    const { tools } = await mcp.listTools();
    await mcp.callTool({ name: "find_slots", arguments: { day: "mon", user_goal: "1: book monday" } });
    const legacy = await mcp.callTool({ name: "legacy_book", arguments: {} });
    await mcp.callTool({ name: "sunny_annotate", arguments: { what_happened: "find_slots had no evening slots" } });
    seen[name] = { tools: tools.map((t) => t.name), instructions: mcp.getInstructions(), legacy };
    await mcp.close();
  }
  await baton.flush();

  expect(seen.alice!.tools).toEqual(["find_slots", "sunny_annotate"]);
  expect(seen.bob!.tools).toEqual(["find_slots", "legacy_book", "sunny_annotate"]);
  expect(seen.alice!.instructions).toMatch(/^Book slots at Sunny\.\n\n.*sunny_annotate/s);
  expect(seen.alice!.legacy.isError).toBe(true);
  expect(seen.bob!.legacy.isError).toBeFalsy();

  const ends = events.filter((e) => e.event_type === "tool_call_end");
  const endOf = (who: string, tool: string) =>
    ends.find((e) => e.principal?.id === who && e.payload.tool_name === tool)!;
  expect(endOf("alice", "find_slots").payload.result_capture).toBe("off");
  expect(JSON.stringify(endOf("alice", "find_slots"))).not.toContain("9am");
  expect(JSON.stringify(endOf("bob", "find_slots").payload.result)).toContain("9am");
  expect(endOf("alice", "find_slots").capture).toEqual({ settings_version: 7, audience: "enterprise", overlay: "ov_1" });

  const starts = events.filter((e) => e.event_type === "tool_call_start" && e.payload.tool_name === "find_slots");
  expect(starts.map((e) => e.payload.call_intent)).toEqual(["1: book monday", "1: book monday"]);
  expect(starts.map((e) => e.payload.params)).toEqual([{ day: "mon" }, { day: "mon" }]);

  const hidden = events.find((e) => e.event_type === "tool_call_error")!;
  expect(hidden.principal.id).toBe("alice");
  expect(hidden.payload.failure_kind).toBe("tool_hidden");

  const reports = events.filter((e) => e.event_type === "annotation");
  expect(reports.map((e) => e.principal.id)).toEqual(["alice", "bob"]);
  expect(events.filter((e) => e.event_type === "surface_snapshot")).toHaveLength(1);
});
