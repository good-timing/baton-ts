/**
 * A low-level `Server` built the way vendors build one by hand: plain JSON
 * Schema tools from `z.toJSONSchema`, one `tools/list` handler and one
 * `tools/call` handler that routes by name. Baton must give it the same tool
 * list additions and the same events as the same tools on an `McpServer`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { Client as ClientV2 } from "@modelcontextprotocol/client";

import type { Event } from "../../../src/events.js";
import type { BatonConfig } from "../../../src/integrations/mcp/config.js";
import { createBaton, withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CapturingSink, CFG, install, lowLevelServerOf, MAJORS, type Major, nextTurn } from "./_majors.js";
import { failingSink } from "../../_sink.js";

const GOAL = "1: find alice; success is her row";

const SHAPES = {
  lookup: { name: z.string() },
  fails: { name: z.string() },
  throws: { name: z.string() },
  own_goal: { user_goal: z.string() },
} satisfies Record<string, Record<string, z.ZodType>>;
type ToolName = keyof typeof SHAPES;

/** What each tool does, given the arguments its handler received. */
function run(name: ToolName, args: Record<string, unknown>): unknown {
  switch (name) {
    case "lookup":
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
    case "fails":
      return { content: [{ type: "text", text: "no such row" }], isError: true };
    case "throws":
      throw new Error("backend down");
    case "own_goal":
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
  }
}

function mcpServer(major: Major): any {
  const server = major.make();
  for (const name of Object.keys(SHAPES) as ToolName[]) {
    major.tool(server, name, SHAPES[name], (args: Record<string, unknown>) => run(name, args));
  }
  mcpServer.last = server;
  return server;
}
mcpServer.last = undefined as any;

interface LowLevel {
  server: any;
  /** How many times the vendor's `tools/list` handler ran. */
  lists: () => number;
  /** The arguments each `tools/call` handed the vendor, as it saw them. */
  received: Record<string, unknown>[];
  /** What its `tools/list` answers, for the `tools` option. */
  tools: unknown[];
}

/** `omit` leaves tools out of the list; `list` answers `tools/list` in its place. */
function lowLevelServer(
  major: Major,
  options: { setHandlers?: boolean; omit?: ToolName[]; list?: (request: any) => unknown } = {},
): LowLevel & { setHandlers: () => void } {
  const { server, listTools: listMethod, callTool: callMethod } = lowLevelServerOf(major);
  let lists = 0;
  const received: Record<string, unknown>[] = [];
  const tools = (Object.keys(SHAPES) as ToolName[])
    .filter((name) => !options.omit?.includes(name))
    .map((name) => ({ name, inputSchema: z.toJSONSchema(z.object(SHAPES[name])) }));
  const listTools = async (request: unknown) => {
    lists += 1;
    return options.list ? options.list(request) : { tools };
  };
  const callTool = async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: args = {} } = request.params;
    received.push({ ...args });
    if (!(name in SHAPES)) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
    return run(name as ToolName, z.object(SHAPES[name as ToolName]).parse(args));
  };
  const setHandlers = () => {
    server.setRequestHandler(listMethod, listTools);
    server.setRequestHandler(callMethod, callTool);
  };
  if (options.setHandlers !== false) setHandlers();
  return { server, lists: () => lists, received, tools, setHandlers };
}

function installed(server: any, config: BatonConfig = {}): { sink: CapturingSink; flush: () => Promise<void>; reportTool: string } {
  const sink = new CapturingSink();
  const handle = install(server, sink, config);
  return { sink, flush: () => handle.flush(), reportTool: handle.annotationToolName };
}

/** One session: list, call every tool once, and report when there is a report tool. */
async function session(major: Major, server: any, reportTool: string): Promise<{ tools: any[]; results: unknown[] }> {
  const client = await major.connect(server, { clientName: "twin" });
  const { tools } = await client.listTools();
  const results: unknown[] = [];
  for (const name of ["lookup", "fails"] as const) {
    results.push(await client.callTool({ name, arguments: { name: "alice", user_goal: GOAL } }));
  }
  // A throw reaches the client as a result from McpServer and as a JSON-RPC
  // error from a low-level Server; that is the SDK's difference, not Baton's.
  await client.callTool({ name: "throws", arguments: { name: "alice", user_goal: GOAL } }).catch(() => undefined);
  results.push(await client.callTool({ name: "own_goal", arguments: { user_goal: "vendor's own" } }));
  if (reportTool !== "") {
    results.push(await client.callTool({ name: reportTool, arguments: { user_goal: GOAL, what_happened: "empty row" } }));
    results.push(await client.callTool({ name: reportTool, arguments: { user_goal: GOAL } }));
  }
  await client.close();
  return { tools, results };
}

/** What Baton added to each listed tool. */
function additions(tools: any[], reportTool: string): Record<string, unknown> {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      tool.name === reportTool
        ? { description: tool.description, inputSchema: tool.inputSchema }
        : {
            user_goal: tool.inputSchema.properties?.user_goal,
            required: tool.inputSchema.required?.includes("user_goal") ?? false,
          },
    ]),
  );
}

/** An event with what differs between any two runs taken out. */
function comparable(event: Event): Record<string, unknown> {
  const copy: Record<string, any> = { ...event, payload: { ...event.payload } };
  for (const key of ["event_id", "captured_at", "session_id", "call_id"]) delete copy[key];
  delete copy.payload.duration_ms;
  return copy;
}

const calls = (sink: CapturingSink) =>
  sink.events.filter((e) => e.event_type !== "surface_snapshot").map(comparable);

/** The lines written to stderr from now on that contain a text. */
function stderrLines(): (text: string) => string[] {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return (text) => write.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(text));
}

/** A tool whose schema throws when read. */
function lazyTool(name: string): { name: string; inputSchema: never } {
  return {
    name,
    get inputSchema(): never {
      throw new Error("lazy schema");
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BATON_DISABLED;
});

describe.each(MAJORS)("$label", (major) => {
  it.each<[string, BatonConfig]>([
    ["defaults", {}],
    ["goal optional", { intentParamMode: "optional" }],
    ["reports on", { reportMode: "on" }],
  ])("adds what McpServer adds and sends the same events: %s", async (_label, config) => {
    const twin = installed(mcpServer(major), config);
    const expected = await session(major, mcpServer.last, twin.reportTool);
    await twin.flush();

    const vendor = lowLevelServer(major);
    const ours = installed(vendor.server, config);
    const actual = await session(major, vendor.server, ours.reportTool);
    await ours.flush();

    expect(ours.reportTool).toBe(twin.reportTool);
    expect(additions(actual.tools, ours.reportTool)).toEqual(additions(expected.tools, twin.reportTool));
    expect(actual.results).toEqual(expected.results);
    expect(calls(ours.sink)).toEqual(calls(twin.sink));
  });
});

describe.each(MAJORS)("$label: a low-level Server", (major) => {
  /** A server `baton` wraps that has served `tools` (its own, by default) once. */
  const listOn = async (baton: ReturnType<typeof createBaton>, tools?: unknown[]) => {
    const listing = lowLevelServer(major, tools && { list: () => ({ tools }) });
    baton.wrap(listing.server);
    await (await major.connect(listing.server)).listTools();
    return listing;
  };
  /** A server `baton` wraps that has taken a request, so it has caught up. */
  const startedServer = async (baton: ReturnType<typeof createBaton>) => {
    const early = lowLevelServer(major);
    baton.wrap(early.server);
    await dispatch(early.server, "tools/call", { name: "other", arguments: {} }).catch(() => undefined);
    return early;
  };

  const call = (client: any, name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const toolCalls = (sink: CapturingSink) => sink.events.filter((e) => e.event_type.startsWith("tool_call"));

  it("knows every tool from the tools option, without running the vendor's list", async () => {
    const sink = new CapturingSink();
    const vendor = lowLevelServer(major);
    const given = vi.fn(() => vendor.tools);
    withBaton(vendor.server, { ...CFG, sink, tools: given });
    const client = await major.connect(vendor.server);
    await call(client, "lookup", { name: "alice", user_goal: GOAL });
    await call(client, "lookup", { name: "bob", user_goal: GOAL });

    expect(given).toHaveBeenCalledTimes(1);
    expect(vendor.lists()).toBe(0);
    expect(vendor.received).toEqual([{ name: "alice" }, { name: "bob" }]);
    expect(toolCalls(sink).map((e: any) => e.payload.call_intent ?? null)).toEqual([GOAL, null, GOAL, null]);
  });

  it("takes user_goal off a call to a tool Baton does not know, records it, and warns once", async () => {
    const warned = stderrLines();
    const sink = new CapturingSink();
    const vendor = lowLevelServer(major, { omit: ["lookup"] });
    const handle = withBaton(vendor.server, { ...CFG, sink });
    const client = await major.connect(vendor.server);
    await call(client, "lookup", { name: "alice", user_goal: GOAL });
    await client.listTools();
    await call(client, "lookup", { name: "bob", user_goal: GOAL });
    await handle.flush();

    expect(vendor.lists()).toBe(1);
    expect(vendor.received).toEqual([{ name: "alice" }, { name: "bob" }]);
    const starts = toolCalls(sink).filter((e) => e.event_type === "tool_call_start");
    expect(starts.map((e: any) => [e.payload.params, e.payload.call_intent ?? null])).toEqual([
      [{ name: "alice" }, GOAL],
      [{ name: "bob" }, GOAL],
    ]);
    expect(toolCalls(sink)).toHaveLength(4);
    expect(warned("pass your tools as the tools option")).toHaveLength(1);
  });

  it("a tool's own user_goal is kept once Baton has read the tool, and taken off before", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const given = lowLevelServer(major);
    withBaton(given.server, { ...CFG, sink: new CapturingSink(), tools: given.tools });
    await call(await major.connect(given.server), "own_goal", { user_goal: "vendor's own" });

    const cold = lowLevelServer(major);
    withBaton(cold.server, { ...CFG, sink: new CapturingSink() });
    const client = await major.connect(cold.server);
    await call(client, "own_goal", { user_goal: "vendor's own" }).catch(() => undefined);
    await client.listTools();
    await call(client, "own_goal", { user_goal: "vendor's own" });

    expect(given.received).toEqual([{ user_goal: "vendor's own" }]);
    expect(cold.received).toEqual([{}, { user_goal: "vendor's own" }]);
  });

  it.each<[string, () => unknown]>([
    ["throws", () => { throw new Error("not ready"); }],
    ["is not an array", () => ({ tools: [] })],
  ])("warns once, and learns from tools/list, when the tools option %s", async (_label, given) => {
    const warned = stderrLines();
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: given as never });
    const client = await major.connect(vendor.server);
    await client.listTools();
    await call(client, "lookup", { name: "alice", user_goal: GOAL });

    expect(vendor.received).toEqual([{ name: "alice" }]);
    expect(warned("tools option")).toHaveLength(1);
  });

  it("refuses a tools option that is neither an array nor a function", () => {
    expect(() => withBaton(lowLevelServer(major).server, { ...CFG, tools: "lookup" as never })).toThrow(/BatonConfig.tools/);
  });

  it.each(["$ref", "oneOf", "anyOf", "allOf"])("adds no user_goal to a tool whose root schema has %s, and takes it off a call", async (key) => {
    const row = { type: "object", properties: { name: { type: "string" } }, additionalProperties: false };
    const inputSchema = { type: "object", ...(key === "$ref" ? { $ref: "#/$defs/row", $defs: { row } } : { [key]: [row] }) };
    const warned = stderrLines();
    const vendor = lowLevelServer(major, { list: () => ({ tools: [{ name: "lookup", inputSchema }] }) });
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink() });
    const client = await major.connect(vendor.server);
    const { tools } = await client.listTools();
    await call(client, "lookup", { name: "alice", user_goal: GOAL });

    expect(tools.find((tool: any) => tool.name === "lookup").inputSchema).toEqual(inputSchema);
    expect(vendor.received).toEqual([{ name: "alice" }]);
    expect(warned("tools option")).toEqual([]);
  });

  const goal = { type: "object", properties: { user_goal: { type: "string" } } };
  it.each([
    ["under a $ref's definitions", { $ref: "#/$defs/q", $defs: { q: goal } }],
    ["in a oneOf branch", { oneOf: [{ type: "object" }, goal] }],
    ["in a nested object", { allOf: [{ properties: { filter: goal } }] }],
    ["in a required list", { allOf: [{ required: ["user_goal"] }] }],
    ["behind a $ref to another document", { $ref: "https://example.com/query.json" }],
    ["under a property named default", { oneOf: [{ properties: { default: { required: ["user_goal"] } } }] }],
    ["under a definition named not", { $ref: "#/$defs/not", $defs: { not: goal } }],
  ])("leaves a call's user_goal when the root combiner names user_goal %s", async (_where, combiner) => {
    const tool = { name: "lookup", inputSchema: { type: "object", ...combiner } };
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [tool] });
    await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(vendor.received).toEqual([{ name: "alice", user_goal: GOAL }]);
  });

  it.each([
    ["forbids it", { allOf: [{}], not: { required: ["user_goal"] } }],
    ["only shows it in sample values", { anyOf: [{}], examples: [{ properties: { user_goal: {} } }] }],
  ])("takes user_goal off a call when the root combiner schema %s", async (_what, combiner) => {
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [{ name: "lookup", inputSchema: { type: "object", ...combiner } }] });
    await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(vendor.received).toEqual([{ name: "alice" }]);
  });

  it("warns once on a task-based call to a tool in no list", async () => {
    const warned = stderrLines();
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink() });
    await dispatch(vendor.server, "tools/call", {
      name: "lookup",
      arguments: { name: "alice", user_goal: GOAL },
      task: { ttl: 1000 },
    }).catch(() => undefined);
    expect(vendor.received).toEqual([{ name: "alice" }]);
    expect(warned("tools option")).toHaveLength(1);
  });

  it("runs the vendor's handler once, and passes its error through unchanged", async () => {
    const plain = lowLevelServer(major);
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink() });
    const failure = async (server: any) =>
      call(await major.connect(server), "throws", { name: "alice" }).catch((err: unknown) => err);

    expect(await failure(vendor.server)).toEqual(await failure(plain.server));
    expect(vendor.received).toEqual([{ name: "alice" }]);
  });

  it("serves the call when the hook and the sink both throw", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const sink = failingSink();
    const resolvePrincipal = () => {
      throw new Error("hook down");
    };
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink, resolvePrincipal, tools: vendor.tools });
    const result = await call(await major.connect(vendor.server), "lookup", { name: "alice", user_goal: GOAL });

    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ name: "alice" }) }]);
    expect(vendor.received).toEqual([{ name: "alice" }]);
  });

  it("installs nothing under BATON_DISABLED", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    process.env.BATON_DISABLED = "1";
    const sink = new CapturingSink();
    const plain = lowLevelServer(major);
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink });
    const client = await major.connect(vendor.server);
    await call(client, "lookup", { name: "alice", user_goal: GOAL });

    expect((await client.listTools()).tools).toEqual((await (await major.connect(plain.server)).listTools()).tools);
    expect(vendor.received).toEqual([{ name: "alice", user_goal: GOAL }]);
    expect(vendor.lists()).toBe(1);
    expect(sink.events).toEqual([]);
  });

  it("works when the vendor sets its handlers after withBaton", async () => {
    const before = lowLevelServer(major, { setHandlers: false });
    withBaton(before.server, { ...CFG, sink: new CapturingSink() });
    before.setHandlers();
    const after = lowLevelServer(major);
    withBaton(after.server, { ...CFG, sink: new CapturingSink() });

    const listed = async (server: any) => (await (await major.connect(server)).listTools()).tools;
    expect(await listed(before.server)).toEqual(await listed(after.server));
  });

  it("changes nothing on a server withBaton is not called on", async () => {
    const wrapped = lowLevelServer(major);
    const sink = new CapturingSink();
    withBaton(wrapped.server, { ...CFG, sink });
    const plain = lowLevelServer(major);
    const client = await major.connect(plain.server);
    const { tools } = await client.listTools();
    await call(client, "lookup", { name: "alice", user_goal: GOAL });

    expect(tools).toEqual(
      (Object.keys(SHAPES) as ToolName[]).map((name) => ({ name, inputSchema: z.toJSONSchema(z.object(SHAPES[name])) })),
    );
    expect(plain.received).toEqual([{ name: "alice", user_goal: GOAL }]);
    expect(sink.events).toEqual([]);
  });

  it("snapshots the vendor's own tools", async () => {
    const sink = new CapturingSink();
    const vendor = lowLevelServer(major);
    const handle = withBaton(vendor.server, { ...CFG, sink, reportMode: "on" });
    const client = await major.connect(vendor.server);
    await client.listTools();
    await call(client, "lookup", { name: "alice", user_goal: GOAL });
    await handle.flush();

    const [snapshot] = sink.events.filter((e) => e.event_type === "surface_snapshot") as any[];
    expect(snapshot.payload.tools).toEqual(
      (Object.keys(SHAPES) as ToolName[])
        .sort()
        .map((name) => ({ name, description: null, inputSchema: z.toJSONSchema(z.object(SHAPES[name])) })),
    );
    expect(snapshot.payload.seam_augmentations.injected_tools).toEqual([handle.annotationToolName]);
  });

  it("follows the caller's audience as McpServer does", async () => {
    const settings = JSON.stringify({
      version: 1,
      audiences: [
        { id: "beta", match: { label: ["beta"] }, capture: { goal: "optional", reports: "off" } },
        { id: "everyone", match: {}, capture: { goal: "required", reports: "on" } },
      ],
    });
    let reads = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!String(url).includes("/v0/settings")) return new Response(null, { status: 202 });
      reads += 1;
      return new Response(settings, { status: 200 });
    });
    const config: BatonConfig = {
      dsn: `https://baton_pk_${"a".repeat(43)}@ingest.example.com/ten_655b084e118b43f88992ee6357fcc23c/srv`,
      settings: "console",
      reportMode: "on",
      vendorDisplayName: "Acme",
      resolvePrincipal: () => ({ principalId: "user-1", labels: ["beta"] }),
    };
    try {
      const listingOn = async (server: any) => {
        const handle = withBaton(server, config);
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        await nextTurn();
        const { tools } = await (await major.connect(server)).listTools();
        await handle.aclose();
        reads = 0;
        return additions(tools, "");
      };
      const expected = await listingOn(mcpServer(major));
      expect(await listingOn(lowLevelServer(major).server)).toEqual(expected);
      expect(Object.keys(expected).sort()).toEqual(Object.keys(SHAPES).sort());
      expect(expected.lookup).toMatchObject({ required: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  /** A request straight to the server's handler map, as a transport with no
   * handshake (a stateless request) delivers it. */
  const dispatch = (server: any, method: string, params: Record<string, unknown>) =>
    server._requestHandlers.get(method)({ jsonrpc: "2.0", id: 1, method, params }, {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification: async () => {},
      sendRequest: async () => ({}),
      mcpReq: { id: 1, method, signal: new AbortController().signal, requestState: () => undefined },
    });

  it("with createBaton, reads the tools option once for every server it wraps", async () => {
    const sink = new CapturingSink();
    const given = vi.fn(() => lowLevelServer(major).tools);
    const baton = createBaton({ ...CFG, sink, tools: given });
    const servers = [lowLevelServer(major), lowLevelServer(major), lowLevelServer(major)];
    for (const vendor of servers) {
      baton.wrap(vendor.server);
      await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    }
    await baton.flush();

    expect(given).toHaveBeenCalledTimes(1);
    expect(servers.map((vendor) => vendor.received)).toEqual([[{ name: "alice" }], [{ name: "alice" }], [{ name: "alice" }]]);
    expect(toolCalls(sink).map((e: any) => e.payload.call_intent ?? null)).toEqual([GOAL, null, GOAL, null, GOAL, null]);
  });

  it("with createBaton, a server per request knows the list another one served", async () => {
    const baton = createBaton({ ...CFG, sink: new CapturingSink() });
    await listOn(baton);

    const fresh = lowLevelServer(major);
    baton.wrap(fresh.server);
    await dispatch(fresh.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(fresh.received).toEqual([{ name: "alice" }]);
  });

  it("takes only user_goal off a tool with a root combiner, and leaves the retired names", async () => {
    const warned = stderrLines();
    const tool = { name: "lookup", inputSchema: { type: "object", allOf: [{}], properties: { expected_result: { type: "string" } } } };
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [tool] });
    await dispatch(vendor.server, "tools/call", {
      name: "lookup",
      arguments: { name: "alice", user_goal: GOAL, expected_result: "a row", overall_task: "1: x" },
    });
    expect(vendor.received).toEqual([{ name: "alice", expected_result: "a row", overall_task: "1: x" }]);
    expect(warned("cold registry")).toEqual([]);
  });

  it("with createBaton, knows every tool any caller's list showed", async () => {
    const all = lowLevelServer(major).tools as Array<{ name: string }>;
    const baton = createBaton({ ...CFG, sink: new CapturingSink() });
    for (const tools of [all, all.filter((tool) => tool.name !== "lookup")]) {
      await listOn(baton, tools);
    }
    const fresh = lowLevelServer(major);
    baton.wrap(fresh.server);
    await dispatch(fresh.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(fresh.received).toEqual([{ name: "alice" }]);
  });

  it("with createBaton, snapshots only the tools a server served", async () => {
    const sink = new CapturingSink();
    const all = lowLevelServer(major).tools as Array<{ name: string }>;
    const baton = createBaton({ ...CFG, sink });
    await listOn(baton, all);

    const fewer = lowLevelServer(major, { list: () => ({ tools: all.filter((tool) => tool.name === "lookup") }) });
    baton.wrap(fewer.server);
    const client = await major.connect(fewer.server);
    await client.listTools();
    await call(client, "lookup", { name: "alice", user_goal: GOAL });
    await baton.flush();

    const snapshots = sink.events.filter((e) => e.event_type === "surface_snapshot") as any[];
    expect(snapshots.map((e) => e.payload.tools.map((tool: any) => tool.name))).toEqual([["lookup"]]);
  });

  it("with createBaton, another server's tool with the report tool's name leaves this server's report tool", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const reportName = withBaton(lowLevelServer(major).server, { ...CFG, sink: new CapturingSink(), reportMode: "on" })
      .annotationToolName;
    const baton = createBaton({ ...CFG, sink: new CapturingSink(), reportMode: "on" });
    await listOn(baton, [{ name: reportName, inputSchema: { type: "object" } }]);

    const fresh = lowLevelServer(major);
    baton.wrap(fresh.server);
    const { tools } = await (await major.connect(fresh.server)).listTools();
    expect(tools.map((tool: any) => tool.name)).toContain(reportName);
  });

  it("with createBaton, never takes off a user_goal any caller's version of the tool declares", async () => {
    const own = { name: "lookup", inputSchema: { type: "object", properties: { user_goal: { type: "string" } } } };
    const plain = { name: "lookup", inputSchema: { type: "object", properties: { name: { type: "string" } } } };
    const baton = createBaton({ ...CFG, sink: new CapturingSink() });
    for (const tool of [own, plain]) {
      await listOn(baton, [tool]);
    }
    const fresh = lowLevelServer(major);
    baton.wrap(fresh.server);
    await dispatch(fresh.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: "vendor's own" } });
    expect(fresh.received).toEqual([{ name: "alice", user_goal: "vendor's own" }]);
  });

  it("with createBaton, keeps a tool's own user_goal another server listed after this one started", async () => {
    const own = { name: "lookup", inputSchema: { type: "object", properties: { user_goal: { type: "string" } } } };
    const baton = createBaton({ ...CFG, sink: new CapturingSink() });
    const early = await startedServer(baton);

    await listOn(baton, [own]);
    await dispatch(early.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: "vendor's own" } });
    expect(early.received).toContainEqual({ name: "alice", user_goal: "vendor's own" });
  });

  it("with createBaton, takes Baton's user_goal off a plain tool with a nested user_goal another server listed later", async () => {
    const nested = {
      name: "lookup",
      inputSchema: { type: "object", properties: { name: { type: "string" }, filter: goal } },
    };
    const baton = createBaton({ ...CFG, sink: new CapturingSink() });
    const early = await startedServer(baton);

    await listOn(baton, [nested]);
    await dispatch(early.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(early.received).toContainEqual({ name: "alice" });
  });

  it("with createBaton, keeps user_goal on a root combiner tool when any caller's version names it", async () => {
    const deep = { name: "lookup", inputSchema: { type: "object", $ref: "#/$defs/q", $defs: { q: goal } } };
    const plain = { name: "lookup", inputSchema: { type: "object", allOf: [{ type: "object" }] } };
    const baton = createBaton({ ...CFG, sink: new CapturingSink() });
    for (const tool of [deep, plain]) {
      await listOn(baton, [tool]);
    }
    const fresh = lowLevelServer(major);
    baton.wrap(fresh.server);
    await dispatch(fresh.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: "vendor's own" } });
    expect(fresh.received).toEqual([{ name: "alice", user_goal: "vendor's own" }]);
  });

  it("skips only the given tool it cannot read", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const [first, ...rest] = lowLevelServer(major).tools as Array<{ name: string }>;
    const lazy = lazyTool("lazy");
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [lazy, first!, ...rest] });
    await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(vendor.received).toEqual([{ name: "alice" }]);
  });

  it("leaves user_goal on a call to a given tool it cannot read, with one warning", async () => {
    const warned = stderrLines();
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [lazyTool("lookup")] });
    await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(vendor.received).toEqual([{ name: "alice", user_goal: GOAL }]);
    expect(warned("lookup")).toEqual([expect.stringContaining("could not read tool")]);
  });

  it("with createBaton, takes Baton's user_goal off a given tool it could not read once a list shows it", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const lazy = lazyTool("lookup");
    const baton = createBaton({ ...CFG, sink: new CapturingSink(), tools: [lazy] });
    const early = await startedServer(baton);

    await listOn(baton);
    await dispatch(early.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(early.received).toContainEqual({ name: "alice" });
  });

  it("serves and keeps user_goal on a root combiner tool whose search throws", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const branch = {
      get properties(): never {
        throw new Error("lazy branch");
      },
    };
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [{ name: "lookup", inputSchema: { type: "object", oneOf: [branch] } }] });
    await major.connect(vendor.server);
    await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(vendor.received).toEqual([{ name: "alice", user_goal: GOAL }]);
  });

  it("keeps user_goal on a root combiner tool whose search throws, however often it is listed", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const branch = {
      get properties(): never {
        throw new Error("lazy branch");
      },
    };
    const tools = [{ name: "lookup", inputSchema: { type: "object", oneOf: [branch] } }];
    const vendor = lowLevelServer(major, { list: () => ({ tools }) });
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink() });
    await dispatch(vendor.server, "tools/list", {});
    await dispatch(vendor.server, "tools/list", {});
    await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    expect(vendor.received).toEqual([{ name: "alice", user_goal: GOAL }]);
  });

  it("serves a given tool whose name throws, and every other one", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const nameless = {
      get name(): never {
        throw new Error("lazy name");
      },
    };
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [nameless, ...vendor.tools] });
    await dispatch(vendor.server, "tools/call", { name: "own_goal", arguments: { user_goal: "vendor's own" } });
    expect(vendor.received).toEqual([{ user_goal: "vendor's own" }]);
  });

  it("answers initialize when reading a given tool throws", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tool = lazyTool("lookup");
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [tool] });
    const client = await major.connect(vendor.server);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("refuses a Client, which has the same handler map as a Server", () => {
    const Client = major === MAJORS[0] ? ClientV1 : ClientV2;
    expect(() => withBaton(new Client({ name: "c", version: "1" }) as never, CFG)).toThrow(/low-level Server/);
  });

  it("reads the tools option on a call with no handshake", async () => {
    const sink = new CapturingSink();
    const vendor = lowLevelServer(major);
    const handle = withBaton(vendor.server, { ...CFG, sink, tools: vendor.tools });
    await dispatch(vendor.server, "tools/call", { name: "lookup", arguments: { name: "alice", user_goal: GOAL } });
    await handle.flush();
    expect(vendor.lists()).toBe(0);
    expect(vendor.received).toEqual([{ name: "alice" }]);
    expect(toolCalls(sink).map((e: any) => e.payload.call_intent ?? null)).toEqual([GOAL, null]);
  });

  it("takes user_goal off, and sends nothing, on a task-based call", async () => {
    const sink = new CapturingSink();
    const vendor = lowLevelServer(major);
    const handle = withBaton(vendor.server, { ...CFG, sink, tools: vendor.tools });
    await dispatch(vendor.server, "tools/call", {
      name: "lookup",
      arguments: { name: "alice", user_goal: GOAL },
      task: { ttl: 1000 },
    }).catch(() => undefined);
    await handle.flush();
    expect(vendor.received).toEqual([{ name: "alice" }]);
    expect(toolCalls(sink)).toEqual([]);
  });

  const retired = { expected_result: "a row", overall_task: "1: x" };
  it.each([
    ["takes user_goal off", { allOf: [{ type: "object" }] }, {}, { name: "alice" }],
    ["leaves user_goal on", { $ref: "#/$defs/q", $defs: { q: goal } }, {}, { name: "alice", user_goal: GOAL }],
    [
      "takes only user_goal off",
      { allOf: [{}], properties: { expected_result: { type: "string" } } },
      retired,
      { name: "alice", ...retired },
    ],
  ])("%s a task-based call to a root combiner tool as on any call", async (_what, combiner, sent, received) => {
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [{ name: "lookup", inputSchema: { type: "object", ...combiner } }] });
    await dispatch(vendor.server, "tools/call", {
      name: "lookup",
      arguments: { name: "alice", user_goal: GOAL, ...sent },
      task: { ttl: 1000 },
    }).catch(() => undefined);
    expect(vendor.received).toEqual([received]);
  });

  it("takes the subagent sentence out before initialize when a given tool has its own user_goal", async () => {
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: vendor.tools });
    const client = await major.connect(vendor.server);
    expect(client.getInstructions() ?? "").not.toContain("subagent");

    const without = lowLevelServer(major, { omit: ["own_goal"] });
    withBaton(without.server, { ...CFG, sink: new CapturingSink(), tools: without.tools });
    expect((await major.connect(without.server)).getInstructions()).toContain("subagent");
  });

  it("takes the subagent sentence out for a given tool with a root $ref and its own user_goal", async () => {
    const own = { name: "own_ref", inputSchema: { type: "object", $ref: "#/$defs/q", $defs: { q: {} }, properties: { user_goal: { type: "string" } } } };
    const vendor = lowLevelServer(major);
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), tools: [own] });
    expect((await major.connect(vendor.server)).getInstructions() ?? "").not.toContain("subagent");
  });

  it("keeps what earlier pages listed, and adds the report tool once, on the first page", async () => {
    const pages: Record<string, { tools: unknown[]; nextCursor?: string }> = {
      first: { tools: [{ name: "lookup", inputSchema: z.toJSONSchema(z.object(SHAPES.lookup)) }], nextCursor: "2" },
      "2": { tools: [{ name: "own_goal", inputSchema: z.toJSONSchema(z.object(SHAPES.own_goal)) }] },
    };
    const vendor = lowLevelServer(major, { list: (request) => pages[request.params?.cursor ?? "first"] });
    const handle = withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), reportMode: "on" });
    const client = await major.connect(vendor.server);
    const first = await client.listTools();
    // The 2.x client fetches every page itself.
    const second = first.nextCursor === undefined ? { tools: [] } : await client.listTools({ cursor: first.nextCursor });
    await call(client, "lookup", { name: "alice", user_goal: GOAL });

    const names = [...first.tools, ...second.tools].map((tool: any) => tool.name);
    expect(names).toEqual(["lookup", handle.annotationToolName, "own_goal"]);
    expect(vendor.received).toEqual([{ name: "alice" }]);
  });

  it("leaves the vendor's own tool alone when it has the report tool's name", async () => {
    const reportName = withBaton(lowLevelServer(major).server, { ...CFG, sink: new CapturingSink(), reportMode: "on" })
      .annotationToolName;
    const vendor = lowLevelServer(major, {
      list: () => ({
        tools: [{ name: reportName, description: "the vendor's", inputSchema: { type: "object", properties: {} } }],
      }),
    });
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), reportMode: "on" });
    const client = await major.connect(vendor.server);
    const { tools } = await client.listTools();
    const result = await call(client, reportName, { user_goal: GOAL, what_happened: "x" });

    expect(tools.map((tool: any) => tool.description)).toEqual(["the vendor's"]);
    expect(result.content).toEqual([{ type: "text", text: `Unknown tool ${reportName}` }]);
  });

  it("drops the report pointer from the instructions when a given tool has the report tool's name", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const reportName = withBaton(lowLevelServer(major).server, { ...CFG, sink: new CapturingSink(), reportMode: "on" })
      .annotationToolName;
    const tools = [{ name: reportName, inputSchema: { type: "object", properties: {} } }];
    const vendor = lowLevelServer(major, { list: () => ({ tools }) });
    withBaton(vendor.server, { ...CFG, sink: new CapturingSink(), reportMode: "on", tools });
    const client = await major.connect(vendor.server);
    expect(client.getInstructions() ?? "").not.toContain(reportName);
    expect(client.getInstructions()).toContain("subagent");
  });
});
