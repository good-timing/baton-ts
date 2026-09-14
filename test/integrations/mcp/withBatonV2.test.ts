/**
 * Same real-round-trip shape as `withBaton.test.ts`, against the official
 * SDK's **v2** packages (`@modelcontextprotocol/server` +
 * `@modelcontextprotocol/client`, both 2.0.0) instead of 1.x's
 * `@modelcontextprotocol/sdk`.
 *
 * v2 is a devDependency only — `package.json`'s peerDependency stays 1.x
 * until the import re-point lands. These tests exist because v2 dispatches
 * tool calls through `entry.executor`, a closure built at registration, so
 * 1.x's `entry.handler` patch is a SILENT no-op there: the vendor handler
 * runs, the wrapper never fires, and a healthy-looking server emits zero
 * events. Measured against `@modelcontextprotocol/server@2.0.0`.
 */

import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CLIENT_INFO_META_KEY } from "../../../src/integrations/mcp/runtimeAdapter.js";
import type { Event } from "../../../src/events.js";
import type { Sink } from "../../../src/sinks.js";

class CapturingSink implements Sink {
  readonly events: Event[] = [];
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {}
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG = { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" };

/** v2's `McpServer` is a different class from 1.x's — this compiles only
 * because `withBaton` takes the structural `SupportedMcpServer` both
 * satisfy. If it ever needs a cast, the signature regressed. */
function install(server: McpServer, sink: Sink) {
  return withBaton(server, { ...CONFIG, sink });
}

let vendorSawArgs: Record<string, unknown> | null = null;

function registerTools(server: McpServer): void {
  server.registerTool(
    "echo",
    { description: "Echo", inputSchema: z.object({ text: z.string() }) },
    async (args: any) => {
      vendorSawArgs = { ...args };
      return { content: [{ type: "text" as const, text: String(args.text) }] };
    },
  );
  server.registerTool("boom", { description: "Boom" }, async () => {
    throw new Error("simulated failure");
  });
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const props = (tool: any): string[] => Object.keys(tool?.inputSchema?.properties ?? {});

describe("withBaton on the official SDK v2", () => {
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
    vendorSawArgs = null;
  });

  it("captures tool_call_start/end for a tool registered AFTER withBaton (prospective)", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    install(server, sink);
    registerTools(server);

    const client = await connectClient(server);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });

    expect(result.isError).toBeFalsy();
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
    expect(sink.events[1]!.payload).toMatchObject({ tool_name: "echo", params: { text: "hi" } });
    // The pairing key, on v2's own dispatch path. `batonWrap` is shared, but
    // v2 reaches it through `entry.executor` rather than `entry.handler`, and
    // that difference has already made one wrapper a silent no-op here.
    expect(sink.events[1]!.call_id).toEqual(expect.any(String));
    expect(sink.events[2]!.call_id).toBe(sink.events[1]!.call_id);
    expect(sink.events[0]!.call_id).toBeNull(); // surface_snapshot
  });

  it("captures for a tool registered BEFORE withBaton (retroactive — the executor closure)", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
  });

  it("emits tool_call_error and re-raises for a failing tool", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const client = await connectClient(server);
    const result = await client.callTool({ name: "boom", arguments: {} });

    expect(result.isError).toBeTruthy();
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_error",
    ]);
  });

  it("wraps a schema-less tool without injecting into it (executor passes args=undefined)", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    let ran = false;
    server.registerTool("ping", { description: "Ping" }, async () => {
      ran = true;
      return { content: [{ type: "text" as const, text: "pong" }] };
    });
    install(server, sink);

    const client = await connectClient(server);
    const listed = await client.listTools();
    expect(props(listed.tools.find((t) => t.name === "ping"))).toEqual([]);

    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(ran).toBe(true);
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
  });

  it("advertises injected intent params on a real tools/list and strips them before the vendor", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const client = await connectClient(server);
    const listed = await client.listTools();
    expect(props(listed.tools.find((t) => t.name === "echo"))).toEqual([
      "text",
      "user_goal",
      "expected_result",
      "overall_task",
    ]);

    await client.callTool({
      name: "echo",
      arguments: { text: "hi", user_goal: "ship the port" },
    });

    // Stripped in place: the vendor handler must never see Baton's params.
    expect(vendorSawArgs).toEqual({ text: "hi" });
    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    expect(start.payload).toMatchObject({ params: { text: "hi" }, call_intent: "ship the port" });
  });

  it("busts _toolInputSchemaJson so the HTTP Mcp-Param-* pre-dispatch scan sees the injection", async () => {
    // tools/list re-converts per request, but v2's memo — read by the
    // createMcpHandler HTTP entry's SEP-2243 pre-dispatch validation — is
    // written eagerly at registration and never refreshed by a list. Left
    // stale, injected params work over stdio and vanish over HTTP.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const memo = (server as any).toolInputSchemaJson("echo");
    expect(Object.keys(memo?.properties ?? {})).toEqual([
      "text",
      "user_goal",
      "expected_result",
      "overall_task",
    ]);
  });

  it("re-wraps after update({callback}), which regenerates the executor", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    (server as any)._registeredTools.echo.update({
      callback: async (args: any) => {
        vendorSawArgs = { ...args };
        return { content: [{ type: "text" as const, text: "v2 callback" }] };
      },
    });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi", user_goal: "g" } });

    expect(sink.events.map((e) => e.event_type)).toContain("tool_call_end");
    expect(vendorSawArgs).toEqual({ text: "hi" });
  });

  it("prunes the surface on remove(), which v2 routes through update({name: null})", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    (server as any)._registeredTools.echo.remove();

    const client = await connectClient(server);
    await client.callTool({ name: "boom", arguments: {} });

    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    const names = snapshot.payload.tools.map((t) => t["name"]);
    expect(names).not.toContain("echo");
    expect(names).toContain("boom");
  });

  it("re-keys the surface on a rename via update({name})", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    (server as any)._registeredTools.echo.update({ name: "echo_renamed" });

    const client = await connectClient(server);
    await client.callTool({ name: "echo_renamed", arguments: { text: "hi", user_goal: "g" } });

    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    const names = snapshot.payload.tools.map((t) => t["name"]);
    expect(names).toContain("echo_renamed");
    expect(names).not.toContain("echo");
    // The param registry and the wrapper's own name must follow the rename,
    // or events keep arriving under the dead name and the strip degrades to
    // the cold-registry path.
    expect(vendorSawArgs).toEqual({ text: "hi" });
    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    expect(start.payload).toMatchObject({ tool_name: "echo_renamed", call_intent: "g" });
  });

  it("registers a working annotation tool, whose own executor Baton never wraps", async () => {
    // The one tool Baton itself registers, and the only path that goes
    // through v2's ORIGINAL registerTool (the annotate tool is registered
    // before the patch, by deliberate ordering) and the @deprecated
    // raw-shape overload. Its executor is never wrapped, so the handler has
    // to read v2's context shape itself.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const client = await connectClient(server);
    const result = await client.callTool({
      name: "vendor_annotate",
      arguments: { user_goal: "wire up baton" },
      _meta: { "claudecode/toolUseId": "tu_ann" },
    });

    expect(result.isError).toBeFalsy();
    expect(sink.events.map((e) => e.event_type)).toEqual(["annotation"]);
    const annotation = sink.events[0]!;
    expect(annotation.runtime_meta).toMatchObject({ "claudecode/toolUseId": "tu_ann" });
    // The annotation tool runs its OWN copy of the ladder, outside the
    // wrapper. Wiring only the wrapper would show up exactly here — as one
    // session reporting two runtimes for one client, tool events naming it
    // and annotations saying `unknown`. Same value as the tool-call leg
    // above, on purpose.
    expect(annotation.agent_runtime).toBe("test-client");
    expect(annotation.payload).toMatchObject({ intent: "wire up baton" });

    // A proactive annotation claims the session's proactive slot, so a later
    // injected user_goal must NOT synthesise a second one.
    await client.callTool({ name: "echo", arguments: { text: "hi", user_goal: "g" } });
    expect(sink.events.filter((e) => e.event_type === "annotation")).toHaveLength(1);
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "annotation",
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
  });

  it("injection preserves the vendor's own object semantics (.refine / strictObject)", async () => {
    // Rebuilding from `.shape` would drop both, handing the vendor's handler
    // arguments its own schema rejects — installing Baton must not weaken a
    // vendor's validation. `.extend()` keeps them.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    let refinedSaw: Record<string, unknown> | null = null;
    server.registerTool(
      "refined",
      {
        description: "Refined",
        inputSchema: z
          .object({ a: z.string(), b: z.string() })
          .refine((v) => v.a !== v.b, "a must differ from b"),
      },
      async (args: any) => {
        refinedSaw = { ...args };
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    );
    server.registerTool(
      "strict",
      { description: "Strict", inputSchema: z.strictObject({ text: z.string() }) },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    install(server, sink);

    const client = await connectClient(server);
    const listed = await client.listTools();
    // Still advertised, and strictness survives into the rendered schema.
    expect(props(listed.tools.find((t) => t.name === "refined"))).toEqual([
      "a",
      "b",
      "user_goal",
      "expected_result",
      "overall_task",
    ]);
    expect(listed.tools.find((t) => t.name === "strict")?.inputSchema.additionalProperties).toBe(
      false,
    );

    const violating = await client.callTool({
      name: "refined",
      arguments: { a: "x", b: "x", user_goal: "g" },
    });
    expect(violating.isError).toBeTruthy();
    expect(refinedSaw).toBeNull();

    const valid = await client.callTool({
      name: "refined",
      arguments: { a: "x", b: "y", user_goal: "g" },
    });
    expect(valid.isError).toBeFalsy();
    expect(refinedSaw).toEqual({ a: "x", b: "y" });
  });

  it("drops a disabled tool from the surface snapshot, as tools/list does", async () => {
    // `disable()` is `update({enabled:false})` on both majors, so it reaches
    // the same patched `update` that removal does — and leaving the tool in
    // the snapshot is the same phantom-tool defect, by a different route.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    (server as any)._registeredTools.echo.disable();

    const client = await connectClient(server);
    const listed = await client.listTools();
    await client.callTool({ name: "boom", arguments: {} });

    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    const names = snapshot.payload.tools.map((t) => t["name"]);
    expect(listed.tools.map((t) => t.name)).not.toContain("echo");
    expect(names).not.toContain("echo");
    expect(names).toContain("boom");
  });

  it("renders one $schema spelling even for a tool captured while disabled", async () => {
    // v2's `toolInputSchemaJson` returns undefined for a disabled tool; the
    // 1.x fallback converter would put draft-07 in a snapshot whose other
    // tools are draft-2020-12 — two spellings, one server, one hash.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const entry = (server as any)._registeredTools.echo;
    entry.disable();
    entry.update({ paramsSchema: z.object({ text: z.string(), extra: z.number().optional() }) });
    entry.enable();

    const client = await connectClient(server);
    await client.callTool({ name: "boom", arguments: {} });

    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    // `boom` declares no inputSchema, so it carries v2's empty-object
    // constant, which has no `$schema` at all — that is correct, not a third
    // spelling. Every tool that HAS one must agree.
    const spellings = new Set(
      snapshot.payload.tools
        .map((t) => (t["inputSchema"] as Record<string, unknown>)["$schema"])
        .filter((v): v is string => typeof v === "string"),
    );
    expect([...spellings]).toEqual(["https://json-schema.org/draft/2020-12/schema"]);
    const echoSchema = snapshot.payload.tools.find((t) => t["name"] === "echo")!;
    expect((echoSchema["inputSchema"] as Record<string, unknown>)["properties"]).toHaveProperty(
      "extra",
    );
  });

  it("reads _meta from v2's ctx.mcpReq, not the 1.x top-level extra._meta", async () => {
    // v2's ServerContext is {sessionId, mcpReq, http} — `_meta` moved under
    // `mcpReq`. Read only at the 1.x location, every v2 session silently
    // degrades to agent_runtime "unknown" with no runtime_meta.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
      _meta: { "claudecode/toolUseId": "tu_1" },
    });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    // `runtime_meta` is what proves the read location — it carries the key
    // verbatim, and is empty if `_meta` was sought at the 1.x spot.
    expect(start.runtime_meta).toMatchObject({ "claudecode/toolUseId": "tu_1" });
    // `agent_runtime` used to carry that proof too, via the `claudecode/*`
    // heuristic. It no longer can: this client DECLARES `test-client` in its
    // handshake, and a declaration outranks the heuristic. The assertion is
    // kept, pointed at what it now proves — that tier 2 reaches the client's
    // name on v2's own dispatch path, and reports the CLIENT rather than the
    // server (which is named `vendor`, the value a mis-wired tier 2 gives).
    expect(start.agent_runtime).toBe("test-client");
  });

  it("tier 1: reads a request-borne declaration out of v2's LIFTED envelope", async () => {
    // The measurement that made this port more than a transcription. v2
    // lifts every reserved `io.modelcontextprotocol/*` key OUT of the `_meta`
    // a handler sees and re-exposes it under `ctx.mcpReq.envelope`; 1.x
    // leaves it in `_meta`. Sending the identical `_meta` to both majors,
    // this key arrived in two different places — so a faithful line-by-line
    // port of Python (which reads `_meta` alone) would pass every 1.x test
    // and be a silent `unknown` across the whole v2 major, the exact shape of
    // the `clientInfo`/`client_info` bug one layer down.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    install(server, sink);

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
      _meta: {
        [CLIENT_INFO_META_KEY]: { name: "gateway-declared", version: "1" },
        "claudecode/toolUseId": "tu_1",
      },
    });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    // Outranks BOTH the handshake (`test-client`) and the heuristic.
    expect(start.agent_runtime).toBe("gateway-declared");
    // And the proof that the lift really happened on this peer: the reserved
    // key is GONE from what the handler saw as `_meta`, while the unreserved
    // one beside it survived. If v2 ever stops lifting, this flips and the
    // envelope read above becomes dead code rather than silently redundant.
    expect(start.runtime_meta).toEqual({ "claudecode/toolUseId": "tu_1" });
  });
});
