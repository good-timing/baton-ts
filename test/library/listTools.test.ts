/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client, withBaton, type Event, type Sink } from "../../src/index.js";
import { SENT_SURFACES_CAP } from "../../src/integrations/mcp/surface.js";

class CollectingSink implements Sink {
  readonly events: Event[] = [];
  failNext = 0;
  async write(event: Event): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("collector down");
    }
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {}
}

const TOOLS = [
  {
    name: "get_weather",
    description: "Weather for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  },
  { name: "list_cities", inputSchema: { type: "object", properties: {} } },
];
const SERVER_INFO = { name: "sunny", version: "1.4" };

function setup() {
  const sink = new CollectingSink();
  const client = new Client({ sink, vendorId: "srv-1", tenantId: "ten_abc" });
  return { sink, client };
}

async function snapshots(client: Client, sink: CollectingSink): Promise<Array<Record<string, any>>> {
  await client.flush();
  return sink.events
    .filter((e) => e.event_type === "surface_snapshot")
    .map((e) => JSON.parse(JSON.stringify(e)) as Record<string, any>);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(
  JSON.parse(readFileSync(path.join(here, "..", "..", "baton-spec", "events.schema.json"), "utf-8")) as object,
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function adapterListedSchema(): Promise<Record<string, any>> {
  const server = new McpServer({ name: "parity", version: "1.0.0" });
  server.registerTool("get_weather", { inputSchema: { city: z.string() } }, () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  withBaton(server, { vendorId: "srv-1", vendorDisplayName: "Sunny", sink: new CollectingSink() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new McpClient({ name: "parity", version: "1.0.0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  const { tools } = await mcp.listTools();
  return tools.find((t) => t.name === "get_weather")!.inputSchema as Record<string, any>;
}

describe("Client.listTools", () => {
  it("adds user_goal exactly as withBaton adds it", async () => {
    const adapter = await adapterListedSchema();
    const { client } = setup();
    const [served] = (await client.listTools(TOOLS)) as Array<Record<string, any>>;

    const schema = served!.inputSchema as Record<string, any>;
    expect(schema.properties.user_goal).toEqual(adapter.properties.user_goal);
    expect(schema.properties.user_goal.description).toMatch(/^REQUIRED\. /);
    expect(schema.required).toContain("user_goal");
    expect(adapter.required).toContain("user_goal");
  });

  it("adds user_goal to a schema whose properties are undefined", async () => {
    const { client } = setup();
    const [served] = (await client.listTools([
      { name: "ping", inputSchema: { type: "object", properties: undefined } },
    ])) as Array<Record<string, any>>;

    expect(served!.inputSchema.required).toEqual(["user_goal"]);
    expect(served!.inputSchema.properties).toHaveProperty("user_goal");
  });

  it("adds user_goal to a tool entry a class built", async () => {
    class ToolEntry {
      constructor(
        readonly name: string,
        readonly inputSchema: Record<string, unknown>,
      ) {}
    }
    const { client } = setup();
    const [served] = (await client.listTools([new ToolEntry("ping", { type: "object" })])) as Array<
      Record<string, any>
    >;

    expect(served!.inputSchema.required).toEqual(["user_goal"]);
  });

  it("leaves a tool that declares user_goal its own", async () => {
    const own = { type: "string", description: "the vendor's own field" };
    const { client } = setup();
    const [served] = (await client.listTools([
      { name: "plan", inputSchema: { type: "object", properties: { user_goal: own } } },
    ])) as Array<Record<string, any>>;

    expect(served!.inputSchema.properties.user_goal).toEqual(own);
    expect(served!.inputSchema).not.toHaveProperty("required");
  });

  it("snapshots the vendor's own surface, sorted by name", async () => {
    const { sink, client } = setup();
    const reversed = [...TOOLS].reverse();
    await client.listTools(reversed, {
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      instructions: "Ask about weather.",
    });

    const [snapshot] = (await snapshots(client, sink));
    expect(validate(snapshot)).toBe(true);
    expect(snapshot!.payload).toMatchObject({
      server_info: SERVER_INFO,
      capabilities: { tools: {} },
      instructions: "Ask about weather.",
      tools: TOOLS,
      seam_augmentations: {
        injected_tools: [],
        intent_param: { names: ["user_goal"], required_names: ["user_goal"], mode: "required" },
        instructions_suffix: null,
      },
    });
    expect(snapshot!.payload.surface_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("sends one snapshot for the same tools and does not change the input", async () => {
    const { sink, client } = setup();
    const before = structuredClone(TOOLS);
    await client.listTools(TOOLS);
    await client.listTools([...TOOLS].reverse());
    expect(await snapshots(client, sink)).toHaveLength(1);
    expect(TOOLS).toEqual(before);
  });

  it("sends another snapshot when the surface changes", async () => {
    const { sink, client } = setup();
    await client.listTools(TOOLS);
    await client.listTools(TOOLS, { instructions: "new" });
    await client.listTools(TOOLS.slice(0, 1));
    expect(new Set((await snapshots(client, sink)).map((s) => s.payload.surface_hash)).size).toBe(3);
  });

  it("takes no session, principal or client from an open block", async () => {
    const { sink, client } = setup();
    await client.session(
      { sessionId: "conv-1", principal: { principalId: "u1" }, clientInfo: { name: "cli" }, turnId: "t1" },
      () => client.listTools(TOOLS),
    );
    const [snapshot] = (await snapshots(client, sink));
    expect(snapshot!.session_id).not.toBe("conv-1");
    expect(snapshot!.session_id_origin).toBe("minted");
    expect(snapshot!.principal).toBeNull();
    expect(snapshot!.client_observed).toBeNull();
    expect(snapshot!.runtime_meta).toBeNull();
  });

  it("never rejects over a failed write, and sends it on the next list", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { sink, client } = setup();
    sink.failNext = 1;
    const served = await client.listTools(TOOLS);
    expect(served).toHaveLength(2);
    expect(await snapshots(client, sink)).toHaveLength(0);
    await client.listTools(TOOLS);
    expect(await snapshots(client, sink)).toHaveLength(1);
  });

  it("returns a list it cannot read as it came", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { sink, client } = setup();
    const unreadable = {
      name: "x",
      get inputSchema(): never {
        throw new Error("no");
      },
    };
    const served = await client.listTools([unreadable]);
    expect(served[0]).toBe(unreadable);
    expect(await snapshots(client, sink)).toHaveLength(0);
  });

  it("serves an entry that is not an object, or has no schema object, unchanged", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { client } = setup();
    const served = await client.listTools(["odd", { name: "bare" }, { name: "n", inputSchema: "x" }]);
    expect(served).toEqual(["odd", { name: "bare" }, { name: "n", inputSchema: "x" }]);
  });

  it("keeps a queued snapshot as it was when the vendor edits its tools", async () => {
    const sink = new CollectingSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Sink = {
      write: async (event) => {
        await gate;
        await sink.write(event);
      },
      flush: async () => {},
      aclose: async () => {},
    };
    const client = new Client({ sink: slow, vendorId: "srv-1" });
    const tools = structuredClone(TOOLS);
    const listed = client.listTools(tools);
    tools[0]!.description = "edited";
    await listed;
    release();
    expect((await snapshots(client, sink))[0]!.payload.tools[0].description).toBe("Weather for a city.");
  });

  it("remembers only the last SENT_SURFACES_CAP surfaces", async () => {
    const { sink, client } = setup();
    for (let i = 0; i <= SENT_SURFACES_CAP; i++) await client.listTools(TOOLS, { instructions: String(i) });
    await client.listTools(TOOLS, { instructions: String(SENT_SURFACES_CAP) });
    expect(await snapshots(client, sink)).toHaveLength(SENT_SURFACES_CAP + 1);
    await client.listTools(TOOLS, { instructions: "0" });
    expect(await snapshots(client, sink)).toHaveLength(SENT_SURFACES_CAP + 2);
  });

  it("serves the vendor's tools and sends nothing under BATON_DISABLED", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("BATON_DISABLED", "1");
    const { sink, client } = setup();
    const served = await client.listTools(TOOLS);
    expect(served).toEqual(TOOLS);
    expect(sink.events).toHaveLength(0);
  });

  it("still adds user_goal once closed, so the schema agents see does not change, and sends nothing", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { sink, client } = setup();
    await client.aclose();
    const [served] = (await client.listTools(TOOLS)) as Array<Record<string, any>>;
    expect(served!.inputSchema.required).toContain("user_goal");
    expect(sink.events).toHaveLength(0);
  });

  it("hashes the payload it sends, without keys whose value is undefined", async () => {
    const { sink, client } = setup();
    await client.listTools([{ name: "x", description: undefined, inputSchema: { type: "object" } }]);
    await client.listTools([{ name: "x", inputSchema: { type: "object" } }]);
    const sent = await snapshots(client, sink);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.tools[0]).not.toHaveProperty("description");
  });

  it("drops a surface that does not fit the schema once, not on every list", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { sink, client } = setup();
    const options = { instructions: 42 as unknown as string };
    await client.listTools(TOOLS, options);
    await client.listTools(TOOLS, options);
    expect(await snapshots(client, sink)).toHaveLength(0);
    expect(stderr.mock.calls.filter(([c]) => String(c).includes("does not fit the schema"))).toHaveLength(1);
  });

  it("is waited on by flush", async () => {
    const sink = new CollectingSink();
    const slow: Sink = {
      write: (event) => new Promise((resolve) => setTimeout(() => resolve(sink.write(event)), 5)),
      flush: async () => {},
      aclose: async () => {},
    };
    const client = new Client({ sink: slow, vendorId: "srv-1" });
    void client.listTools(TOOLS);
    await client.flush();
    expect(await snapshots(client, sink)).toHaveLength(1);
  });
});

describe("Client.session meta", () => {
  it("sends the request's meta, scrubbed, with the vendor's turn id", async () => {
    const { sink, client } = setup();
    client.session(
      {
        turnId: "t1",
        meta: { "claudecode/toolUseId": "tu_1", note: "mail bob@example.com", "baton/turn_id": "client's" },
      },
      () => client.trace({ toolName: "x" }, () => 1),
    );
    await client.flush();
    expect(sink.events[0]!.runtime_meta).toEqual({
      "claudecode/toolUseId": "tu_1",
      note: "mail [REDACTED:email]",
      "baton/turn_id": "t1",
    });
  });

  it("prefers the clientInfo declared in meta, and falls back to clientInfo", async () => {
    const { sink, client } = setup();
    const meta = { "io.modelcontextprotocol/clientInfo": { name: "from-meta", version: "2" } };
    client.session({ clientInfo: { name: "passed" }, meta }, () => client.trace({ toolName: "a" }, () => 1));
    client.session({ clientInfo: { name: "passed" }, meta: { other: 1 } }, () =>
      client.trace({ toolName: "b" }, () => 1),
    );
    await client.flush();
    expect(sink.events[0]!.client_observed).toEqual({ info: { name: "from-meta", version: "2" } });
    expect(sink.events[2]!.client_observed).toEqual({ info: { name: "passed" } });
  });

  it("drops meta that is not an object, with a warning", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { sink, client } = setup();
    client.session({ meta: "nope" as unknown as Record<string, unknown> }, () =>
      client.trace({ toolName: "x" }, () => 1),
    );
    await client.flush();
    expect(sink.events[0]!.runtime_meta).toBeNull();
    expect(stderr.mock.calls.map(([c]) => String(c)).join("")).toContain("meta is not an object");
  });

  it("costs only the meta when the scrubber returns no object for it", async () => {
    const sink = new CollectingSink();
    const client = new Client({
      sink,
      vendorId: "srv-1",
      scrubber: (value) => (typeof value === "object" && value !== null && "k" in value ? "flat" : value),
    });
    client.session({ turnId: "t1", meta: { k: 1 } }, () => client.trace({ toolName: "x" }, () => 1));
    await client.flush();
    expect(sink.events[0]!.runtime_meta).toEqual({ "baton/turn_id": "t1" });
  });
});
