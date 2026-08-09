/**
 * In-process interceptor tests — a real `Client` talking to a real
 * `McpServer` over `InMemoryTransport.createLinkedPair()`. This is the
 * direct TS analogue of Python's FastMCP in-process `Client` tests (AGENTS.md
 * boundary rule 4: fake fixtures, not a real vendor, but a real protocol
 * round-trip) — and the only shape that actually exercises the
 * registration-ordering question `withBaton` has to get right, since
 * `_registeredTools` reflects real `McpServer` internals, not a mock.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
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

function registerTools(server: McpServer): void {
  server.registerTool(
    "echo",
    { inputSchema: { text: z.string() } },
    async (args: { text: string }) => ({ content: [{ type: "text" as const, text: args.text }] }),
  );
  server.registerTool("boom", {}, async () => {
    throw new Error("simulated failure");
  });
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("withBaton", () => {
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
  });

  it("captures tool_call_start/end for a tool registered AFTER withBaton (prospective wrap)", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });
    registerTools(server);

    const client = await connectClient(server);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });

    expect(result.isError).toBeFalsy();
    expect(sink.events.map((e) => e.event_type)).toEqual(["tool_call_start", "tool_call_end"]);
    const [start, end] = sink.events;
    expect(start!.payload).toMatchObject({ tool_name: "echo", params: { text: "hi" } });
    expect(end!.payload).toMatchObject({ tool_name: "echo" });
    expect(start!.sequence_number).toBe(1);
    expect(end!.sequence_number).toBe(2);
    expect(start!.session_id).toBe(end!.session_id);
    expect(start!.tenant_id).toBe("acme");
    expect(start!.vendor_id).toBe("acme");
    expect(start!.consent_token).toBe("ct");
  });

  it("captures tool_call_start/end for a tool registered BEFORE withBaton (retroactive wrap)", async () => {
    // This is the ordering the design note flagged as the real footgun: a
    // naive registerTool-only patch would see nothing here, since these
    // tools exist before withBaton ever runs.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });

    expect(result.isError).toBeFalsy();
    expect(sink.events.map((e) => e.event_type)).toEqual(["tool_call_start", "tool_call_end"]);
  });

  it("captures tool_call_error and rethrows so the client still sees an error result", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    const result = await client.callTool({ name: "boom", arguments: {} });

    // Our wrapper rethrows; McpServer's own executeToolHandler converts
    // that into an isError CallToolResult for the client — the vendor's
    // error-reporting contract with its own caller is unchanged.
    expect(result.isError).toBe(true);

    expect(sink.events.map((e) => e.event_type)).toEqual(["tool_call_start", "tool_call_error"]);
    const errorEvent = sink.events[1]!;
    expect(errorEvent.payload).toMatchObject({
      tool_name: "boom",
      error_type: "Error",
      error_body: "simulated failure",
    });
    if (errorEvent.event_type === "tool_call_error") {
      expect(errorEvent.payload.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps sequence numbers monotonic per session across multiple calls", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "one" } });
    await client.callTool({ name: "echo", arguments: { text: "two" } });

    expect(sink.events.map((e) => e.sequence_number)).toEqual([1, 2, 3, 4]);
  });

  it("scrubs params/result through the configured scrubber", async () => {
    // A real scrubber redacts leaf values but preserves container shape —
    // params must stay a record per the wire schema (matches Python's
    // equally-strict Pydantic `dict[str, Any]`). A scrubber that replaces
    // the whole value wholesale (e.g. blanket `() => "REDACTED"`) would
    // break that shape; that's a scrubber-configuration bug, not something
    // withBaton should paper over — see the "drops an event whose scrubbed
    // payload no longer matches the wire schema" test below for how it's
    // handled (fail-open per SPEC §11.2, not a crash).
    function redactStrings(value: unknown): unknown {
      if (typeof value === "string") return "REDACTED";
      if (Array.isArray(value)) return value.map(redactStrings);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, redactStrings(v)]),
        );
      }
      return value;
    }

    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink, scrubber: redactStrings });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "secret" } });

    const [start, end] = sink.events;
    expect(start!.payload).toMatchObject({ params: { text: "REDACTED" } });
    expect(JSON.stringify(end!.payload)).not.toContain("secret");
  });

  it("drops an event whose scrubbed payload no longer matches the wire schema, fail-open", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    // Wholesale replacement breaks `params`' record shape — event
    // construction (Zod validation) fails; the tool call must still
    // succeed per SPEC §11.2 fail-open.
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink, scrubber: () => "REDACTED" });

    const client = await connectClient(server);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });

    expect(result.isError).toBeFalsy();
    // tool_call_start's `params` must be a record — scrubbed to a bare
    // string, it fails Zod validation and is dropped. tool_call_end's
    // `result` has no such shape constraint (`z.unknown()`), so it still
    // gets through — the fail-open behavior is per-event, not all-or-nothing.
    expect(sink.events.map((e) => e.event_type)).toEqual(["tool_call_end"]);
  });

  it("throws at withBaton() time when consentToken is missing", () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    expect(() =>
      withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "", sink }),
    ).toThrow(/consentToken/);
  });

  it("throws at withBaton() time when vendorDisplayName is missing", () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    expect(() =>
      withBaton(server, { vendorId: "acme", vendorDisplayName: "", consentToken: "ct", sink }),
    ).toThrow(/vendorDisplayName/);
  });
});

describe("withBaton — instructions + annotation tool", () => {
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
  });

  it("injects server instructions referencing the annotation tool name", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const handle = withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    expect(handle.annotationToolName).toBe("acme_annotate");

    const client = await connectClient(server);
    const instructions = client.getInstructions();

    expect(instructions).toContain("acme_annotate");
    expect(instructions).toContain("Acme");
    // Whitelabel obligation (SPEC §5.4) — no Baton-branded strings reach
    // the calling agent.
    expect(instructions?.toLowerCase()).not.toContain("baton");
  });

  it("registers a discoverable, callable annotate tool", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("acme_annotate");

    const result = await client.callTool({
      name: "acme_annotate",
      arguments: { intent: "look something up", expected_outcome: "a match" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("emits a proactive annotation event and does NOT emit tool_call_start/end for the annotate call itself", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({
      name: "acme_annotate",
      arguments: { intent: "look something up", expected_outcome: "a match", workflow: "lookup" },
    });

    expect(sink.events.map((e) => e.event_type)).toEqual(["annotation"]);
    expect(sink.events[0]!.payload).toMatchObject({
      intent: "look something up",
      expected_outcome: "a match",
      workflow: "lookup",
      signal_type: null,
    });
  });

  it("emits a reactive annotation event with signal_type + suggested_improvement", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } }); // start/end noise
    sink.events.length = 0;

    await client.callTool({
      name: "acme_annotate",
      arguments: {
        intent: "look something up",
        signal_type: "feature_gap",
        suggested_improvement: "add a bulk lookup tool",
      },
    });

    expect(sink.events.map((e) => e.event_type)).toEqual(["annotation"]);
    expect(sink.events[0]!.payload).toMatchObject({
      signal_type: "feature_gap",
      suggested_improvement: "add a bulk lookup tool",
    });
  });

  it("annotate call and regular tool calls share one monotonic sequence per session", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.callTool({ name: "acme_annotate", arguments: { intent: "x" } });

    expect(sink.events.map((e) => [e.event_type, e.sequence_number])).toEqual([
      ["tool_call_start", 1],
      ["tool_call_end", 2],
      ["annotation", 3],
    ]);
    // Same session across both call sites.
    const sessionIds = new Set(sink.events.map((e) => e.session_id));
    expect(sessionIds.size).toBe(1);
  });

  it("respects an annotationToolName override", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const handle = withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      annotationToolName: "record_feedback",
    });

    expect(handle.annotationToolName).toBe("record_feedback");
    const client = await connectClient(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("record_feedback");
    expect(tools.map((t) => t.name)).not.toContain("acme_annotate");
  });

  it("throws at withBaton() time on an invalid annotationToolName override", () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    expect(() =>
      withBaton(server, {
        vendorId: "acme",
        vendorDisplayName: "Acme",
        consentToken: "ct",
        sink,
        annotationToolName: "not.valid",
      }),
    ).toThrow(/cross-runtime/);
  });
});
