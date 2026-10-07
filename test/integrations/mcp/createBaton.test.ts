/** Each "request" here is its own `McpServer` and its own linked client, which
 * is what a stateless HTTP server that builds a server per request sees. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBaton, withBaton } from "../../../src/index.js";
import { CapturingSink, CFG, MAJORS, type Major } from "./_majors.js";

const DSN = `https://baton_pk_${"a".repeat(43)}@ingest.example.com/ten_655b084e118b43f88992ee6357fcc23c/echo-server`;

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));
}

async function serveOneRequest(
  major: Major,
  instrument: (server: never) => void,
  toolName = "echo",
): Promise<string[]> {
  const server = major.make();
  major.tool(server, toolName, { text: z.string() }, (args: { text: string }) => ({
    content: [{ type: "text" as const, text: args.text }],
  }));
  instrument(server as never);
  const client = await major.connect(server);
  const { tools } = (await client.listTools()) as { tools: { name: string }[] };
  await client.callTool({ name: toolName, arguments: { text: "hi" } });
  await client.close();
  return tools.map((tool) => tool.name);
}

const count = (sink: CapturingSink, type: string): number =>
  sink.events.filter((event) => event.event_type === type).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.BATON_DISABLED;
  delete process.env.BATON_DSN;
  delete process.env.BATON_TENANT_ID;
});

describe.each(MAJORS)("createBaton on $label", (major) => {
  it("emits the surface once for the process, not once per request", async () => {
    const sink = new CapturingSink();
    const baton = createBaton({ ...CFG, sink });
    for (let i = 0; i < 3; i++) await serveOneRequest(major, (server) => baton.wrap(server));

    expect(count(sink, "surface_snapshot")).toBe(1);
    expect(count(sink, "tool_call_start")).toBe(3);
    expect(count(sink, "tool_call_end")).toBe(3);
  });

  it("withBaton per request repeats the surface, which is what createBaton removes", async () => {
    const sink = new CapturingSink();
    for (let i = 0; i < 3; i++) {
      await serveOneRequest(major, (server) => withBaton(server, { ...CFG, sink }));
    }

    expect(count(sink, "surface_snapshot")).toBe(3);
  });

  it("gives each request its own session id, shared by that request's events", async () => {
    const sink = new CapturingSink();
    const baton = createBaton({ ...CFG, sink });
    for (let i = 0; i < 2; i++) await serveOneRequest(major, (server) => baton.wrap(server));

    const starts = sink.events.filter((event) => event.event_type === "tool_call_start");
    const ends = sink.events.filter((event) => event.event_type === "tool_call_end");
    expect(starts[0]!.session_id).toBe(ends[0]!.session_id);
    expect(starts[1]!.session_id).toBe(ends[1]!.session_id);
    expect(starts[0]!.session_id).not.toBe(starts[1]!.session_id);
  });

  it("builds one HttpSink from a DSN, however many requests it wraps", async () => {
    stubFetch();
    const before = process.listenerCount("beforeExit");
    const baton = createBaton({ dsn: DSN, consentToken: "ct" });
    for (let i = 0; i < 3; i++) await serveOneRequest(major, (server) => baton.wrap(server));
    await baton.flush();

    expect(process.listenerCount("beforeExit") - before).toBe(1);
    expect(fetch).toHaveBeenCalled();
    await baton.aclose();
  });

  it("withBaton per request builds a sink per request, which is the leak", async () => {
    stubFetch();
    const before = process.listenerCount("beforeExit");
    for (let i = 0; i < 3; i++) {
      await serveOneRequest(major, (server) => withBaton(server, { dsn: DSN, consentToken: "ct" }));
    }

    expect(process.listenerCount("beforeExit") - before).toBe(3);
  });

  it("sends one surface when the first requests arrive together", async () => {
    const sink = new CapturingSink();
    let releaseWrites = (): void => {};
    const writesHeld = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const write = sink.write.bind(sink);
    sink.write = async (event) => {
      await writesHeld;
      await write(event);
    };
    const baton = createBaton({ ...CFG, sink });

    const requests = [0, 1, 2].map(() => serveOneRequest(major, (server) => baton.wrap(server)));
    // Long enough for all three to reach their first write and wait on it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseWrites();
    await Promise.all(requests);

    expect(count(sink, "surface_snapshot")).toBe(1);
  });

  it("sends the surface again after a failed write", async () => {
    const sink = new CapturingSink();
    const write = sink.write.bind(sink);
    let failures = 1;
    sink.write = async (event) => {
      if (event.event_type === "surface_snapshot" && failures-- > 0) throw new Error("sink down");
      await write(event);
    };
    const baton = createBaton({ ...CFG, sink });
    for (let i = 0; i < 2; i++) await serveOneRequest(major, (server) => baton.wrap(server));

    expect(count(sink, "surface_snapshot")).toBe(1);
  });

  it("reads the environment once, when it is created", async () => {
    stubFetch();
    process.env.BATON_DSN = DSN;
    const baton = createBaton({ consentToken: "ct" });
    delete process.env.BATON_DSN;
    process.env.BATON_DISABLED = "1";

    const tools = await serveOneRequest(major, (server) => baton.wrap(server));
    await baton.flush();

    expect(tools).toContain("vendor_annotate");
    expect(fetch).toHaveBeenCalled();
    await baton.aclose();
  });

  it("keeps the tenant it was created with", async () => {
    const sink = new CapturingSink();
    process.env.BATON_TENANT_ID = "ten_at_startup";
    const baton = createBaton({ ...CFG, sink });
    process.env.BATON_TENANT_ID = "ten_later";
    await serveOneRequest(major, (server) => baton.wrap(server));

    expect(new Set(sink.events.map((event) => event.tenant_id))).toEqual(new Set(["ten_at_startup"]));
  });

  it("installs nothing when BATON_DISABLED is set", async () => {
    process.env.BATON_DISABLED = "1";
    const sink = new CapturingSink();
    const baton = createBaton({ ...CFG, sink });
    const tools = await serveOneRequest(major, (server) => baton.wrap(server));

    expect(tools).toEqual(["echo"]);
    expect(sink.events).toEqual([]);
  });
});

describe("createBaton", () => {
  const major = MAJORS[0]!;

  it("forgets old surfaces when every request brings a new one", async () => {
    const sink = new CapturingSink();
    const baton = createBaton({ ...CFG, sink });
    const wrap = (server: never): void => baton.wrap(server);
    await serveOneRequest(major, wrap, "tool_first");
    for (let i = 0; i < 1024; i++) await serveOneRequest(major, wrap, `tool_${i}`);
    await serveOneRequest(major, wrap, "tool_first");

    const firstSurface = sink.events.find((event) => event.event_type === "surface_snapshot")!;
    const sameSurface = sink.events.filter(
      (event) =>
        event.event_type === "surface_snapshot" &&
        event.payload.surface_hash === firstSurface.payload.surface_hash,
    );
    expect(sameSurface).toHaveLength(2);
  });

  it("warns about an ignored BATON_DSN once, not once per request", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    process.env.BATON_DSN = DSN;
    const baton = createBaton({ ...CFG, sink: new CapturingSink() });
    for (let i = 0; i < 3; i++) await serveOneRequest(major, (server) => baton.wrap(server));

    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("names the vendor after each server when a DSN gives no display name", async () => {
    stubFetch();
    const baton = createBaton({ dsn: DSN, consentToken: "ct" });
    const server = new McpServer({ name: "Toybox Pantry", version: "1.0.0" });
    baton.wrap(server);

    const internals = server as unknown as { server: { _instructions: string } };
    expect(internals.server._instructions).toContain("Toybox Pantry");
    await baton.aclose();
  });

  it("closes the shared sink only from the baton itself", async () => {
    const sink = new CapturingSink();
    const baton = createBaton({ ...CFG, sink });
    await serveOneRequest(major, (server) => baton.wrap(server));
    expect(sink.closed).toBe(false);

    await baton.aclose();
    expect(sink.closed).toBe(true);
  });

  it.each([
    ["no display name", { vendorId: "acme", consentToken: "ct" }],
    ["an annotation tool name clients reject", { ...CFG, annotationToolName: "acme.annotate" }],
  ])("refuses %s when it is created, not on the first request", (_, config) => {
    expect(() => createBaton(config)).toThrow();
  });
});
