/** `serve()`: Baton around a vendor's own MCP dispatch (SPEC §5.6). The cases
 * are Python's `tests/test_library_serve.py`, by name.
 *
 * `fetch` is stubbed: Console settings need a DSN, so events and the settings
 * read both go through it. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, reportTool, type ClientOptions, type Event, type Sink } from "../../src/index.js";
import { INTENT_INSTRUCTIONS } from "../../src/integrations/mcp/llmText.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

const KEY = "baton_pk_" + "a".repeat(43);
const WORKSPACE = "ten_655b084e118b43f88992ee6357fcc23c";
const DSN = `https://${KEY}@ingest.example.com/${WORKSPACE}/srv_lib`;
const REPORT = reportTool({ vendorDisplayName: "Sunny" }).name;
const GOAL = "1: book a slot";

const TOOLS: Record<string, any>[] = [
  {
    name: "find_slots",
    description: "Finds slots.",
    inputSchema: { type: "object", properties: { day: { type: "string" } }, required: ["day"] },
  },
  { name: "legacy_book", description: "Old.", inputSchema: { type: "object" } },
];

const EVERYONE = { id: "everyone", match: {}, capture: {} };
const HIDES_LEGACY = {
  version: 3,
  audiences: [{ ...EVERYONE, overlay: "ov_1" }],
  overlays: { ov_1: { actions: [{ target: { tool: "legacy_book" }, remove: true }] } },
};
const RESULTS_OFF = { version: 4, audiences: [{ ...EVERYONE, capture: { results: "off" } }] };
const OWN_GOAL = { name: "own", inputSchema: { type: "object", properties: { user_goal: { type: "string" } } } };
const CLASHING = { name: REPORT, description: "Mine.", inputSchema: { type: "object" } };

interface Collector {
  events: Record<string, any>[];
  settingsReads: number;
}

/** Answers `GET /v0/settings` with `document` and records the events posted. */
function stubCollector(document: unknown): Collector {
  const collector: Collector = { events: [], settingsReads: 0 };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("/v0/settings")) {
      collector.settingsReads += 1;
      return document === null
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(document), { status: 200, headers: { etag: '"e"' } });
    }
    const body = JSON.parse(init.body as string) as { events?: Record<string, unknown>[] };
    collector.events.push(...(body.events ?? [body]));
    return new Response(null, { status: 202 });
  });
  return collector;
}

class MemorySink implements Sink {
  readonly events: Event[] = [];
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {}
}

/** A hand-written MCP server's dispatch: message in, answer out. */
class Vendor {
  readonly seen: any[] = [];
  readonly answers: any[] = [];
  callAnswer: any = null;
  raises: Error | null = null;
  readonly dispatch = (message: any): any => this.answer(message);

  constructor(readonly tools: Record<string, any>[] = TOOLS) {}

  answer(message: any): any {
    this.seen.push(message);
    if (this.raises !== null) throw this.raises;
    const method = message?.method;
    let result: any = {};
    if (method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "Sunny", version: "1" },
        capabilities: { tools: {} },
        instructions: "Vendor text.",
      };
    } else if (method === "tools/list") {
      result = { tools: structuredClone(this.tools) };
    } else if (method === "tools/call" && this.callAnswer !== null) {
      this.answers.push(this.callAnswer);
      return this.callAnswer;
    } else if (method === "tools/call") {
      result = { content: [{ type: "text", text: "booked 42" }], isError: false };
    }
    const answer = { jsonrpc: "2.0", id: message?.id, result };
    this.answers.push(answer);
    return answer;
  }
}

interface Harness {
  client: Client;
  collector: Collector;
  /** The events sent so far, of one type. */
  of(type: string): Promise<Record<string, any>[]>;
}

const made: Client[] = [];

async function harness(document: unknown = null, options: ClientOptions = {}): Promise<Harness> {
  const collector = stubCollector(document);
  const client = new Client({ dsn: DSN, settings: "console", vendorDisplayName: "Sunny", ...options });
  made.push(client);
  if ((options.settings ?? "console") === "console") {
    await vi.waitFor(() => expect(collector.settingsReads).toBeGreaterThan(0));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    client,
    collector,
    of: async (type) => {
      await client.flush();
      return collector.events.filter((e) => e.event_type === type);
    },
  };
}

afterEach(async () => {
  for (const client of made.splice(0)) await client.aclose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const initialize = () => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { clientInfo: { name: "claude-code", version: "2" } },
});
const list = (cursor?: string) => ({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} });
const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name, arguments: args },
});
const names = (answer: any): string[] => answer.result.tools.map((tool: any) => tool.name);
const tool = (answer: any, name: string): any => answer.result.tools.find((t: any) => t.name === name);

/** The lines written to stderr from now on that contain a text. */
function stderrLines(): (text: string) => string[] {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return (text) => write.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(text));
}

describe("what serve() adds", () => {
  it("puts Baton's text below the vendor's on initialize", async () => {
    const h = await harness();
    const answer: any = await h.client.serve(initialize(), new Vendor().dispatch);
    const instructions: string = answer.result.instructions;
    expect(instructions.startsWith("Vendor text.\n\n")).toBe(true);
    expect(instructions).toContain(REPORT);
    expect(instructions.endsWith(INTENT_INSTRUCTIONS)).toBe(true);
    expect(answer.result.serverInfo).toEqual({ name: "Sunny", version: "1" });
  });

  it("gives the list user_goal and the report tool", async () => {
    const h = await harness();
    const answer = await h.client.serve(list(), new Vendor().dispatch);
    expect(names(answer)).toEqual(["find_slots", "legacy_book", REPORT]);
    const schema = tool(answer, "find_slots").inputSchema;
    expect(schema.properties.day).toEqual({ type: "string" });
    expect(schema.properties).toHaveProperty("user_goal");
    expect(schema.required).toEqual(["day", "user_goal"]);
    const [snapshot, ...more] = await h.of("surface_snapshot");
    expect(more).toEqual([]);
    expect(snapshot!.payload.tools.map((t: any) => t.name)).toEqual(["find_slots", "legacy_book"]);
    expect(snapshot!.payload.seam_augmentations.injected_tools).toEqual([REPORT]);
    expect(snapshot!.payload.seam_augmentations.server_overlay).toBeNull();
  });

  it("adds user_goal and no report tool with local settings", async () => {
    const h = await harness(null, { settings: "local" });
    expect(names(await h.client.serve(list(), new Vendor().dispatch))).toEqual(["find_slots", "legacy_book"]);
    const [snapshot] = await h.of("surface_snapshot");
    expect(snapshot!.payload.seam_augmentations).not.toHaveProperty("server_overlay");
  });

  it("puts the report tool on a paged list's first page", async () => {
    const h = await harness();
    const paged = (message: any) => {
      const answer = new Vendor().answer(message);
      answer.result.nextCursor = "p2";
      return answer;
    };
    expect(names(await h.client.serve(list(), paged))).toContain(REPORT);
    expect(names(await h.client.serve(list("p2"), new Vendor().dispatch))).not.toContain(REPORT);
  });

  it("takes user_goal off a call and traces it", async () => {
    const h = await harness();
    const vendor = new Vendor();
    await h.client.serve(list(), vendor.dispatch);
    const answer = await h.client.serve(call("find_slots", { day: "mon", user_goal: GOAL }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ day: "mon" });
    expect(answer).toBe(vendor.answers.at(-1));
    const [start] = await h.of("tool_call_start");
    expect(start!.payload.call_intent).toBe(GOAL);
    expect(start!.payload.params).toEqual({ day: "mon" });
    const [end] = await h.of("tool_call_end");
    expect(JSON.stringify(end!.payload.result)).toContain("booked 42");
  });

  it("sends the principal and headers with the call", async () => {
    const h = await harness();
    await h.client.serve(call("find_slots", { day: "mon" }), new Vendor().dispatch, {
      principal: { principalId: "u1", organization: { organizationId: "acme", labels: ["vip"] } },
      headers: { "user-agent": "claude-code/2" },
    });
    const [start] = await h.of("tool_call_start");
    expect(start!.principal.id).toBe("u1");
    expect(start!.labels).toEqual(["vip"]);
    expect(start!.client_observed).not.toBeNull();
  });

  it("answers a report itself", async () => {
    const h = await harness();
    const vendor = new Vendor();
    const answer: any = await h.client.serve(
      call(REPORT, { user_goal: GOAL, what_happened: "find_slots returned nothing" }),
      vendor.dispatch,
    );
    expect(vendor.seen).toEqual([]);
    expect(answer.id).toBe(3);
    expect(answer.result.structuredContent).toEqual({ ok: true });
    const [annotation] = await h.of("annotation");
    expect(annotation!.payload.what_happened).toBe("find_slots returned nothing");
  });

  it("refuses a report with nothing wrong", async () => {
    const h = await harness();
    const answer: any = await h.client.serve(call(REPORT, { user_goal: GOAL }), new Vendor().dispatch);
    expect(answer.result.structuredContent.ok).toBe(false);
    expect(await h.of("annotation")).toEqual([]);
  });

  it("answers a hidden tool as the MCP SDK answers a tool it does not have", async () => {
    const h = await harness(HIDES_LEGACY);
    const vendor = new Vendor();
    expect(names(await h.client.serve(list(), vendor.dispatch))).not.toContain("legacy_book");
    const answer: any = await h.client.serve(call("legacy_book", { user_goal: GOAL }), vendor.dispatch);
    expect(answer.result).toEqual({
      content: [{ type: "text", text: "MCP error -32602: Tool legacy_book not found" }],
      isError: true,
    });
    expect(vendor.seen.map((m) => m.method)).toEqual(["tools/list"]);
    const [error] = await h.of("tool_call_error");
    expect(error!.payload.failure_kind).toBe("tool_hidden");
  });

  it("sends every call to dispatch without settings", async () => {
    const h = await harness(null, { settings: "local" });
    const vendor = new Vendor();
    await h.client.serve(call("legacy_book", {}), vendor.dispatch);
    await h.client.serve(call(REPORT, { what_happened: "x" }), vendor.dispatch);
    expect(vendor.seen).toHaveLength(2);
  });

  it("withholds results and errors under results off", async () => {
    const h = await harness(RESULTS_OFF);
    const vendor = new Vendor();
    await h.client.serve(call("find_slots", { day: "mon" }), vendor.dispatch);
    vendor.callAnswer = {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "secret detail" }], isError: true },
    };
    await h.client.serve(call("find_slots", { day: "mon" }), vendor.dispatch);
    vendor.raises = new Error("secret raise");
    await expect(h.client.serve(call("find_slots", { day: "mon" }), vendor.dispatch)).rejects.toThrow("secret raise");
    const errors = await h.of("tool_call_error");
    const sent = JSON.stringify(h.collector.events);
    expect(sent).not.toContain("booked 42");
    expect(sent).not.toContain("secret");
    expect(errors.map((e) => e.payload.result_capture)).toEqual(["off", "off"]);
  });

  it("leaves a tool whose root schema is composite alone", async () => {
    const composite = { name: "pick", inputSchema: { oneOf: [{ type: "object" }, { type: "object" }] } };
    const h = await harness();
    const vendor = new Vendor([composite]);
    expect(tool(await h.client.serve(list(), vendor.dispatch), "pick").inputSchema).toEqual(composite.inputSchema);
    // It declares no user_goal, so the subagent sentence stays.
    const answer: any = await h.client.serve(initialize(), vendor.dispatch);
    expect(answer.result.instructions.endsWith(INTENT_INSTRUCTIONS)).toBe(true);
  });

  it("lets a tool with its own user_goal keep it", async () => {
    const h = await harness();
    const vendor = new Vendor([OWN_GOAL]);
    await h.client.serve(list(), vendor.dispatch);
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "theirs" });
    const answer: any = await h.client.serve(initialize(), vendor.dispatch);
    expect(answer.result.instructions.endsWith(INTENT_INSTRUCTIONS)).toBe(false);
  });

  it.each([
    ["in a branch", { oneOf: [{ type: "object", properties: { user_goal: {} } }] }, true],
    ["in $defs", { $ref: "#/$defs/A", $defs: { A: { properties: { user_goal: {} } } } }, true],
    ["absent", { oneOf: [{ type: "object", properties: { q: {} } }] }, false],
  ])("lets a composite tool keep user_goal only where its schema names it: %s", async (_, schema, kept) => {
    const h = await harness();
    const vendor = new Vendor([{ name: "pick", inputSchema: schema }]);
    await h.client.serve(list(), vendor.dispatch);
    const sent = { user_goal: "theirs", overall_task: "t" };
    await h.client.serve(call("pick", sent), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual(kept ? sent : { overall_task: "t" });
    // Only a root user_goal is where the subagent sentence's turn number goes.
    const answer: any = await h.client.serve(initialize(), vendor.dispatch);
    expect(answer.result.instructions.endsWith(INTENT_INSTRUCTIONS)).toBe(true);
  });

  it.each(["list", "tools"])("leaves the arguments of a tool Baton cannot read: given as %s", async (given) => {
    const odd = [{ name: "odd", inputSchema: "not a schema" }];
    const h = await harness(null, given === "tools" ? { tools: odd } : {});
    const vendor = new Vendor(odd);
    if (given === "list") await h.client.serve(list(), vendor.dispatch);
    const sent = { user_goal: GOAL, q: "x" };
    await h.client.serve(call("odd", sent), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual(sent);
    const answer: any = await h.client.serve(initialize(), vendor.dispatch);
    expect(answer.result.instructions.endsWith(INTENT_INSTRUCTIONS)).toBe(true);
  });

  it("lets a tool once seen keeping user_goal keep it", async () => {
    const h = await harness(null, { tools: [OWN_GOAL] });
    const vendor = new Vendor([{ ...OWN_GOAL, inputSchema: { type: "object" } }]);
    await h.client.serve(list(), vendor.dispatch);
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "theirs" });
  });

  it("takes Baton's user_goal off a tool read later", async () => {
    const h = await harness(null, { tools: [{ name: "find_slots", inputSchema: "not a schema" }] });
    const vendor = new Vendor();
    await h.client.serve(list(), vendor.dispatch);
    await h.client.serve(call("find_slots", { day: "mon", user_goal: GOAL }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ day: "mon" });
  });

  it("takes user_goal off a tool whose properties are null", async () => {
    const h = await harness();
    const vendor = new Vendor([{ name: "nulls", inputSchema: { type: "object", properties: null } }]);
    expect(tool(await h.client.serve(list(), vendor.dispatch), "nulls").inputSchema.required).toEqual(["user_goal"]);
    await h.client.serve(call("nulls", { user_goal: GOAL }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({});
    expect((await h.of("tool_call_start"))[0]!.payload.call_intent).toBe(GOAL);
  });

  it("takes user_goal off a tool with no schema", async () => {
    const h = await harness(null, { tools: [{ name: "find_slots" }] });
    const vendor = new Vendor();
    await h.client.serve(call("find_slots", { day: "mon", user_goal: GOAL }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ day: "mon" });
  });

  it("warns once, naming tools, on a call to a tool in no list", async () => {
    const h = await harness();
    const vendor = new Vendor();
    const warned = stderrLines();
    await h.client.serve(call("find_slots", { day: "mon", user_goal: GOAL }), vendor.dispatch);
    await h.client.serve(call("legacy_book", { user_goal: GOAL }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({});
    const lines = warned("removed user_goal");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tools option");
  });

  it("serves a vendor tool with the report tool's name over Baton's", async () => {
    const mine = { name: REPORT, description: "Mine.", inputSchema: { type: "object" } };
    const h = await harness();
    const vendor = new Vendor([mine]);
    const warned = stderrLines();
    await h.client.serve(list(), vendor.dispatch);
    const answer = await h.client.serve(list(), vendor.dispatch);
    expect(names(answer)).toEqual([REPORT]);
    expect(tool(answer, REPORT).description).toBe("Mine.");
    expect(warned("report tool's name")).toHaveLength(1);
    await h.client.serve(call(REPORT, { what_happened: "x" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.name).toBe(REPORT);
    const init: any = await h.client.serve(initialize(), vendor.dispatch);
    expect(init.result.instructions).not.toContain(REPORT);
  });

  it("warns at install when a given tool has the report tool's name", async () => {
    const warned = stderrLines();
    const unreadable = {
      get name(): never {
        throw new Error("no");
      },
    };
    await harness(null, { tools: [unreadable, CLASHING] });
    expect(warned("report tool's name")).toHaveLength(1);
  });

  it("does not fail install over a given list that cannot be walked", async () => {
    const refusing = new Proxy([], {
      get(target, key, receiver) {
        if (key === Symbol.iterator || key === "length") throw new Error("no");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    await harness(null, { tools: refusing });
  });

  it("sends no snapshot for a paged list", async () => {
    const h = await harness();
    const paged = (message: any) => {
      const answer = new Vendor().answer(message);
      answer.result.nextCursor = "p2";
      return answer;
    };
    await h.client.serve(list(), paged);
    await h.client.serve(list("p2"), new Vendor().dispatch);
    expect(await h.of("surface_snapshot")).toEqual([]);
  });

  it("keeps a block the vendor opened", async () => {
    const h = await harness(null, { settings: "local" });
    await h.client.session({ principal: { principalId: "u9" }, sessionId: "conv-1" }, () =>
      h.client.serve(call("find_slots", { day: "mon" }), new Vendor().dispatch),
    );
    const [start] = await h.of("tool_call_start");
    expect(start!.principal.id).toBe("u9");
    expect(start!.session_id).toBe("conv-1");
  });

  it("still records a failure when the scrubber throws", async () => {
    const h = await harness(null, {
      scrubber: (value) => {
        if (typeof value === "object" && value !== null) throw new Error("scrubber broke");
        return value;
      },
    });
    const vendor = new Vendor();
    vendor.callAnswer = { jsonrpc: "2.0", id: 3, error: { code: -1, message: "bad" } };
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await h.client.serve(call("find_slots", {}), vendor.dispatch)).toBe(vendor.callAnswer);
    expect(await h.of("tool_call_end")).toEqual([]);
    const [error] = await h.of("tool_call_error");
    expect(error!.payload.error_type).toBe("JSONRPCError");
  });

  it("falls back to the vendor id for a server name with no tool name", async () => {
    stubCollector(null);
    const dsn = `https://${KEY}@ingest.example.com/${WORKSPACE}/fastmcp`;
    for (const vendorDisplayName of [undefined, "  "]) {
      const client = new Client({ dsn, settings: "console", ...(vendorDisplayName ? { vendorDisplayName } : {}) });
      made.push(client);
      expect(names(await client.serve(list(), new Vendor().dispatch))).toContain("fastmcp_annotate");
    }
  });
});

describe("serve() never breaks the vendor", () => {
  it("passes the vendor's exception on unchanged", async () => {
    const h = await harness();
    const vendor = new Vendor();
    const theirs = new TypeError("theirs");
    vendor.raises = theirs;
    await expect(h.client.serve(call("find_slots", { day: "mon" }), vendor.dispatch)).rejects.toBe(theirs);
    const [error] = await h.of("tool_call_error");
    expect(error!.payload.error_type).toBe("TypeError");
  });

  it("passes a JSON-RPC error answer on unchanged", async () => {
    const h = await harness();
    const vendor = new Vendor();
    vendor.callAnswer = { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "bad" } };
    expect(await h.client.serve(call("find_slots", {}), vendor.dispatch)).toBe(vendor.callAnswer);
    const [error] = await h.of("tool_call_error");
    expect(error!.payload.error_type).toBe("JSONRPCError");
  });

  const MALFORMED: unknown[] = [
    null,
    [],
    "tools/list",
    { method: "tools/call", params: { name: "find_slots" } },
    { id: 1, method: "tools/call", params: null },
    { id: 1, method: "tools/call", params: { name: 5 } },
    { id: 1, method: "tools/call", params: { name: "x", arguments: [] } },
    { id: 1, method: "ping" },
  ];

  it.each(MALFORMED.map((message, i) => [i, message]))("sends anything else to dispatch as it came: %i", async (_, message) => {
    const h = await harness();
    const vendor = new Vendor();
    expect(await h.client.serve(message, vendor.dispatch)).toBe(vendor.answers.at(-1));
    expect(vendor.seen).toHaveLength(1);
    expect(vendor.seen[0]).toBe(message);
    expect(h.collector.events.filter((e) => e.event_type !== "surface_snapshot")).toEqual([]);
    expect(await h.of("tool_call_start")).toEqual([]);
  });

  it("makes serve a plain dispatch under the off switch", async () => {
    vi.stubEnv("BATON_DISABLED", "1");
    const collector = stubCollector(null);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new Client({ settings: "console" });
    const vendor = new Vendor();
    const message = call("find_slots", { user_goal: GOAL });
    expect(await client.serve(message, vendor.dispatch)).toBe(vendor.answers.at(-1));
    expect(vendor.seen[0]).toBe(message);
    await client.aclose();
    expect(collector.events).toEqual([]);
    expect(collector.settingsReads).toBe(0);
  });

  it("serves the vendor's own answer when a step of Baton's fails", async () => {
    const { Serving } = await import("../../src/library/serve.js");
    const steps = [
      ["initialized", "initialize"],
      ["listed", "tools/list"],
      ["call", "tools/call"],
    ] as const;
    for (const [step, method] of steps) {
      const h = await harness();
      vi.spyOn(Serving.prototype, step).mockImplementation(() => {
        throw new Error("baton broke");
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      for (const message of [initialize(), list(), call("find_slots", { day: "mon" })]) {
        const vendor = new Vendor();
        const answer = await h.client.serve(message, vendor.dispatch);
        expect(vendor.seen).toHaveLength(1);
        if (message.method === method) expect(answer).toEqual(new Vendor().answer(structuredClone(message)));
      }
      vi.restoreAllMocks();
    }
  });

  it("still takes user_goal off when Baton fails before dispatch", async () => {
    const { Serving } = await import("../../src/library/serve.js");
    const h = await harness();
    vi.spyOn(Serving.prototype, "call").mockImplementation(() => {
      throw new Error("baton broke");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const vendor = new Vendor();
    await h.client.serve(call("find_slots", { day: "mon", user_goal: GOAL }), vendor.dispatch);
    // The list Baton served asked for user_goal, so the vendor never sees it.
    expect(vendor.seen).toEqual([call("find_slots", { day: "mon" })]);
  });

  it("never waits on a sink that hangs", async () => {
    const hangs: Sink = {
      write: () => new Promise(() => {}),
      flush: async () => {},
      aclose: async () => {},
    };
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new Client({ vendorId: "v", sink: hangs, reportMode: "on" });
    const vendor = new Vendor();
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      await client.serve(list(), vendor.dispatch);
      await client.serve(call("find_slots", { day: "mon", user_goal: GOAL }), vendor.dispatch);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("cuts a raised message to the cap", async () => {
    const h = await harness(null, { settings: "local", scrubber: (value) => value });
    const vendor = new Vendor();
    vendor.raises = new Error("x".repeat(5000));
    await expect(h.client.serve(call("find_slots", {}), vendor.dispatch)).rejects.toThrow();
    const [error] = await h.of("tool_call_error");
    expect(error!.payload.error_body).toHaveLength(2000);
  });
});

describe("tools: what a process knows before it serves a list", () => {
  it.each(["list", "function"])("keeps a tool's own user_goal before any list: given as a %s", async (given) => {
    const tools = [OWN_GOAL];
    const h = await harness(null, { tools: given === "list" ? tools : () => tools });
    const vendor = new Vendor(tools);
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "theirs" });
  });

  it("lets a tool added to the given list after install keep its own user_goal", async () => {
    const tools: unknown[] = [];
    const h = await harness(null, { tools });
    tools.push(OWN_GOAL);
    const vendor = new Vendor([OWN_GOAL]);
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "theirs" });
  });

  it("sends a call to the vendor's report-named tool to it", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const h = await harness(null, { tools: [CLASHING] });
    const vendor = new Vendor([CLASHING]);
    await h.client.serve(call(REPORT, { what_happened: "x" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.name).toBe(REPORT);
  });

  it("sets the first instructions right", async () => {
    const h = await harness(null, { tools: [OWN_GOAL] });
    const answer: any = await h.client.serve(initialize(), new Vendor([OWN_GOAL]).dispatch);
    expect(answer.result.instructions.endsWith(INTENT_INSTRUCTIONS)).toBe(false);
  });

  it("falls back with one warning when the tools function throws", async () => {
    let calls = 0;
    const h = await harness(null, {
      tools: () => {
        calls += 1;
        throw new Error("no list");
      },
    });
    const vendor = new Vendor([OWN_GOAL]);
    const warned = stderrLines();
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({});
    expect(calls).toBe(1);
    expect(warned("could not read the tools option")).toHaveLength(1);
  });

  it("still learns from a served list after tools", async () => {
    const h = await harness(null, { tools: [TOOLS[0]] });
    const vendor = new Vendor([OWN_GOAL]);
    await h.client.serve(list(), vendor.dispatch);
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "theirs" });
  });

  it("never reads tools under the off switch", async () => {
    vi.stubEnv("BATON_DISABLED", "1");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const refusing = new Proxy([], {
      get() {
        throw new Error("read tools");
      },
    });
    const refuse = () => {
      throw new Error("read tools");
    };
    for (const tools of [refuse, refusing]) {
      const client = new Client({ settings: "console", tools });
      await client.serve(call("own", {}), new Vendor().dispatch);
      await client.aclose();
    }
  });

  it("refuses an async tools function with a warning", async () => {
    const warned = stderrLines();
    const client = new Client({
      vendorId: "v",
      sink: new MemorySink(),
      tools: (async () => [OWN_GOAL]) as unknown as () => unknown[],
    });
    const vendor = new Vendor([OWN_GOAL]);
    await client.serve(call("own", { user_goal: "a" }), vendor.dispatch);
    await client.aclose();
    expect(warned("not async")).toHaveLength(1);
    expect(vendor.seen.at(-1).params.arguments).toEqual({});
  });

  it("reads a null cursor as the first page", async () => {
    const h = await harness();
    const message = { ...list(), params: { cursor: null } };
    expect(names(await h.client.serve(message, new Vendor().dispatch))).toContain(REPORT);
  });

  it("does not count tools already known against the cap", async () => {
    const serve = await import("../../src/library/serve.js");
    const many = Array.from({ length: serve.REMEMBERED_TOOLS }, (_, i) => ({ ...OWN_GOAL, name: `own${i}` }));
    const client = new Client({ vendorId: "v", sink: new MemorySink(), tools: many });
    const vendor = new Vendor(many.slice(1, 2));
    await client.serve(list(), vendor.dispatch);
    await client.serve(call("own0", { user_goal: "kept" }), vendor.dispatch);
    await client.aclose();
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "kept" });
  });
});

describe("old wiring left inside serve()", () => {
  const errors = (warned: (text: string) => string[]) =>
    warned("was called inside serve()").map((line) => line.split("client.")[1]!.split("(")[0]);

  it("is an error once each", async () => {
    const h = await harness();
    const vendor = new Vendor();
    const handWired = async (message: any) => {
      if (message.method === "tools/list") await h.client.listTools(TOOLS);
      return h.client.session({}, () => h.client.trace({ toolName: "find_slots" }, () => vendor.answer(message)));
    };
    const warned = stderrLines();
    for (let i = 0; i < 3; i++) {
      await h.client.serve(list(), handWired);
      await h.client.serve(call("find_slots", { day: "mon" }), handWired);
    }
    expect(errors(warned)).toEqual(["listTools", "trace"]);
  });

  it("is an error when the trace could not start", async () => {
    const h = await harness();
    const vendor = new Vendor();
    const handWired = (message: any) => h.client.trace({ toolName: "find_slots" }, () => vendor.answer(message));
    const warned = stderrLines();
    vi.spyOn(performance, "now").mockImplementationOnce(() => {
      throw new Error("baton broke");
    });
    await h.client.serve(call("find_slots", { day: "mon" }), handWired);
    expect(warned("could not trace the call")).toHaveLength(1);
    expect(errors(warned)).toEqual(["trace"]);
  });

  it("is no error for the other request's wiring", async () => {
    const h = await harness();
    const vendor = new Vendor();
    const ownTiming = async (message: any) => {
      if (message.method === "tools/list") h.client.trace({ toolName: "list_catalog" }, () => null);
      else await h.client.listTools(TOOLS);
      return vendor.answer(message);
    };
    const warned = stderrLines();
    await h.client.serve(list(), ownTiming);
    await h.client.serve(call("find_slots", { day: "mon" }), ownTiming);
    expect(errors(warned)).toEqual([]);
  });

  it("is no error on a request serve() does not record", async () => {
    const h = await harness();
    const tracedRead = (message: any) => {
      h.client.trace({ toolName: "read_resource" }, () => null);
      return new Vendor().answer(message);
    };
    const warned = stderrLines();
    await h.client.serve({ jsonrpc: "2.0", id: 9, method: "resources/read" }, tracedRead);
    await h.client.serve(initialize(), tracedRead);
    expect(errors(warned)).toEqual([]);
  });

  it("does not count work a dispatch starts as inside serve()", async () => {
    const client = new Client({ vendorId: "v", sink: new MemorySink() });
    let later: Promise<void> | undefined;
    const dispatch = (message: any) => {
      later = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
        client.trace({ toolName: "nightly_sync" }, () => null);
      });
      return new Vendor().answer(message);
    };
    const warned = stderrLines();
    await client.serve(call("find_slots", {}), dispatch);
    await later;
    await client.aclose();
    expect(errors(warned)).toEqual([]);
  });

  it("flags nothing of Baton's own in a serve() nested in another", async () => {
    const client = new Client({ vendorId: "v", sink: new MemorySink(), reportMode: "on" });
    const vendor = new Vendor();
    const gateway = () => client.serve(call("find_slots", { day: "mon" }), vendor.dispatch);
    const warned = stderrLines();
    await client.serve(call("find_slots", { day: "mon" }), gateway);
    await client.aclose();
    expect(errors(warned)).toEqual([]);
  });

  it("logs no error for serve() on its own", async () => {
    const h = await harness();
    const vendor = new Vendor();
    const warned = stderrLines();
    await h.client.serve(initialize(), vendor.dispatch);
    await h.client.serve(list(), vendor.dispatch);
    await h.client.serve(call("find_slots", { day: "mon" }), vendor.dispatch);
    await h.client.serve(call(REPORT, { what_happened: "x" }), vendor.dispatch);
    expect(errors(warned)).toEqual([]);
  });

  it("is fine outside serve()", async () => {
    const client = new Client({ vendorId: "v", sink: new MemorySink() });
    const warned = stderrLines();
    await client.session({}, async () => {
      await client.listTools(TOOLS);
      client.trace({ toolName: "find_slots" }, (trace) => trace.observed({}));
    });
    await client.aclose();
    expect(errors(warned)).toEqual([]);
  });

  it("does not read tools twice when the tools function calls serve()", async () => {
    const vendor = new Vendor([OWN_GOAL]);
    let reads = 0;
    // eslint-disable-next-line prefer-const -- assigned after the function that reads it
    let client: Client;
    const throughServe = () => {
      reads += 1;
      void client.serve(list(), vendor.dispatch);
      return [OWN_GOAL];
    };
    client = new Client({ vendorId: "v", sink: new MemorySink(), tools: throughServe });
    await client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    await client.aclose();
    expect(reads).toBe(1);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "theirs" });
  });

  it("skips only the bad entry in tools", async () => {
    const bad = {
      name: "bad",
      get inputSchema(): never {
        throw new Error("unreadable");
      },
    };
    const h = await harness(null, { tools: [bad, OWN_GOAL] });
    const vendor = new Vendor([OWN_GOAL]);
    await h.client.serve(call("own", { user_goal: "theirs" }), vendor.dispatch);
    expect(vendor.seen.at(-1).params.arguments).toEqual({ user_goal: "theirs" });
  });
});
