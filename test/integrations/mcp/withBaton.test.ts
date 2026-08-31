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
import { identityScrub } from "../../../src/scrub.js";
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
    // The first tool call on a fresh install also captures a
    // surface_snapshot (lazy — see withBaton.ts's maybeEmitSurfaceSnapshot).
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
    const [, start, end] = sink.events;
    expect(start!.payload).toMatchObject({ tool_name: "echo", params: { text: "hi" } });
    expect(end!.payload).toMatchObject({ tool_name: "echo" });
    expect(start!.sequence_number).toBe(2);
    expect(end!.sequence_number).toBe(3);
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
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
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

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_error",
    ]);
    const errorEvent = sink.events[2]!;
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

    // surface_snapshot fires once (first call only — the surface hasn't
    // changed by the second call), so the count is 5, not 4.
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
      "tool_call_start",
      "tool_call_end",
    ]);
    expect(sink.events.map((e) => e.sequence_number)).toEqual([1, 2, 3, 4, 5]);
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

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    const end = sink.events.find((e) => e.event_type === "tool_call_end")!;
    expect(start.payload).toMatchObject({ params: { text: "REDACTED" } });
    expect(JSON.stringify(end.payload)).not.toContain("secret");
  });

  it("captures call_workflow and call_expected from injected params, as siblings of params", async () => {
    // `call_workflow` is the task-label grouping key the Console's rung 3b
    // segments sessions on (exact string continuity). Without it a TS-sourced
    // session can't be split into tasks at all — which is why this landed
    // with the baton-spec bump to d5e25ea rather than after it.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        user_goal: "find the thing",
        expected_result: "the thing",
        overall_task: "prepare campaign approval",
      },
    });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    expect(start.payload).toMatchObject({
      call_intent: "find the thing",
      call_expected: "the thing",
      call_workflow: "prepare campaign approval",
      intent_source: "injected_param",
      // All three are stripped before the vendor handler runs — `params`
      // stays exactly the vendor-visible arguments.
      params: { text: "hi" },
    });
  });

  it("advertises overall_task on the wrapped tool's schema and never leaks it to the handler", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    let seenArgs: Record<string, unknown> | undefined;
    server.registerTool("probe", { inputSchema: { text: z.string() } }, (args: { text: string }) => {
      seenArgs = { ...args };
      return { content: [{ type: "text" as const, text: args.text }] };
    });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    const listed = await client.listTools();
    const probe = listed.tools.find((t) => t.name === "probe")!;
    expect(Object.keys(probe.inputSchema.properties as object).sort()).toEqual([
      "expected_result",
      "overall_task",
      "text",
      "user_goal",
    ]);

    await client.callTool({
      name: "probe",
      arguments: { text: "hi", overall_task: "some task" },
    });
    expect(seenArgs).toEqual({ text: "hi" });
  });

  it("scrubs call_workflow deterministically, preserving grouping continuity", async () => {
    // Rung 3b groups on exact string equality, so a scrubbed label must
    // scrub identically every call or one task fragments into many.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    for (const text of ["one", "two"]) {
      await client.callTool({
        name: "echo",
        arguments: { text, overall_task: "invoice for bob@example.com" },
      });
    }

    const workflows = sink.events
      .filter((e) => e.event_type === "tool_call_start")
      .map((e) => (e.payload as { call_workflow: string }).call_workflow);
    expect(workflows).toEqual([
      "invoice for [REDACTED:email]",
      "invoice for [REDACTED:email]",
    ]);
  });

  it("scrubs the annotation tool's task-label field", async () => {
    // Python's annotation.py does NOT scrub this field (shared gap, found
    // 2026-08-11). Closed on this side; see the comment in annotation.ts.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({
      name: "acme_annotate",
      arguments: { user_goal: "do a thing", overall_task: "invoice for bob@example.com" },
    });

    const annotation = sink.events.find((e) => e.event_type === "annotation")!;
    // Agent sends `overall_task`; the wire carries `workflow`.
    expect(annotation.payload).toMatchObject({ workflow: "invoice for [REDACTED:email]" });
  });

  it("scrubs with the default ruleset when no scrubber is configured", async () => {
    // The default is ON (`new Scrubber().scrub`), matching Python's
    // `install_baton`. This is the regression guard for that default: a
    // vendor who configures nothing must still not ship PII to the sink.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "reach me at leak@example.com" } });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    const end = sink.events.find((e) => e.event_type === "tool_call_end")!;
    expect(start.payload).toMatchObject({
      params: { text: "reach me at [REDACTED:email]" },
    });
    // The result echoes the params back, so it must be scrubbed too — this
    // catches a default wired into the start path but not the end path.
    expect(JSON.stringify(end.payload)).not.toContain("leak@example.com");
    expect(JSON.stringify(end.payload)).toContain("[REDACTED:email]");
  });

  it("scrubs the error body with the default ruleset", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    server.registerTool(
      "leaky",
      { description: "throws with PII", inputSchema: {} },
      () => {
        throw new Error("auth failed for ops@example.com");
      },
    );
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "leaky", arguments: {} });

    const errorEvent = sink.events.find((e) => e.event_type === "tool_call_error")!;
    expect(JSON.stringify(errorEvent.payload)).not.toContain("ops@example.com");
    expect(JSON.stringify(errorEvent.payload)).toContain("[REDACTED:email]");
  });

  it("leaves payloads raw when identityScrub is passed as the explicit opt-out", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      scrubber: identityScrub,
    });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "raw@example.com" } });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    expect(start.payload).toMatchObject({ params: { text: "raw@example.com" } });
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
    // surface_snapshot is unaffected — its payload is never scrubbed (it's
    // the vendor's own static tool surface, not caller-supplied data).
    expect(sink.events.map((e) => e.event_type)).toEqual(["surface_snapshot", "tool_call_end"]);
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
      arguments: { user_goal: "look something up", expected_result: "a match" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("emits a proactive annotation event and does NOT emit tool_call_start/end for the annotate call itself", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({
      name: "acme_annotate",
      arguments: {
        user_goal: "look something up",
        expected_result: "a match",
        overall_task: "lookup",
      },
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
        user_goal: "look something up",
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
    await client.callTool({ name: "acme_annotate", arguments: { user_goal: "x" } });

    expect(sink.events.map((e) => [e.event_type, e.sequence_number])).toEqual([
      ["surface_snapshot", 1],
      ["tool_call_start", 2],
      ["tool_call_end", 3],
      ["annotation", 4],
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

describe("withBaton — intent-param injection", () => {
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
  });

  it("injects user_goal/expected_result as optional params on the advertised schema by default", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;

    expect(echo.inputSchema.properties).toHaveProperty("user_goal");
    expect(echo.inputSchema.properties).toHaveProperty("expected_result");
    expect(echo.inputSchema.required).toEqual(["text"]);
  });

  it("does not add a schema to a tool registered with none (zero-arg tools are left alone)", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const boom = tools.find((t) => t.name === "boom")!;
    expect(boom.inputSchema.properties ?? {}).not.toHaveProperty("user_goal");

    // A zero-arg tool's handler still gets called with no args at all —
    // giving it a schema would have flipped the SDK's calling convention
    // and broken this.
    const result = await client.callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("captures call_intent from an injected user_goal, strips it before the vendor handler, and synthesises one proactive annotation", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    let receivedArgs: Record<string, unknown> | undefined;
    server.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async (args: Record<string, unknown>) => {
        receivedArgs = args;
        return { content: [{ type: "text" as const, text: String(args.text) }] };
      },
    );
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: { text: "hi", user_goal: "find the invoice", expected_result: "a total" },
    });

    // Vendor handler never sees the injected params.
    expect(receivedArgs).toEqual({ text: "hi" });

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "annotation",
      "tool_call_start",
      "tool_call_end",
    ]);
    const annotation = sink.events[1]!;
    expect(annotation.payload).toMatchObject({
      intent: "find the invoice",
      expected_outcome: "a total",
      intent_source: "injected_param",
      tool_name: "echo",
    });
    const start = sink.events[2]!;
    expect(start.payload).toMatchObject({
      call_intent: "find the invoice",
      intent_source: "injected_param",
      params: { text: "hi" },
    });
  });

  it("emits at most one proactive annotation per session even across multiple calls carrying user_goal", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "one", user_goal: "goal one" } });
    await client.callTool({ name: "echo", arguments: { text: "two", user_goal: "goal two" } });

    expect(sink.events.filter((e) => e.event_type === "annotation")).toHaveLength(1);
    // The second call's start event still carries its own call_intent even
    // though it didn't open a new proactive.
    const starts = sink.events.filter((e) => e.event_type === "tool_call_start");
    expect(starts.map((e) => e.payload.call_intent)).toEqual(["goal one", "goal two"]);
  });

  it("forwards a tool's own native user_goal param untouched instead of treating it as captured intent", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    let receivedArgs: Record<string, unknown> | undefined;
    server.registerTool(
      "search",
      { inputSchema: { user_goal: z.string() } },
      async (args: Record<string, unknown>) => {
        receivedArgs = args;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    );
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "search", arguments: { user_goal: "the vendor's own field" } });

    // Native disposition: forwarded to the vendor untouched, not stripped.
    expect(receivedArgs).toEqual({ user_goal: "the vendor's own field" });
    // Not treated as captured Baton intent — no proactive annotation, and
    // tool_call_start's call_intent stays null.
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
    const start = sink.events[1]!;
    expect(start.payload).toMatchObject({ call_intent: null, intent_source: null });
  });

  it("intentParamMode 'required' adds user_goal to the schema's required fields; expected_result stays optional", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      intentParamMode: "required",
    });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.required).toEqual(expect.arrayContaining(["text", "user_goal"]));
    expect(echo.inputSchema.required).not.toContain("expected_result");
  });

  it("intentParamMode 'required' adds a required array where the tool's own schema had none", async () => {
    // A tool whose own fields are all optional never had a `required` array
    // to begin with — objectFromShape's rebuilt schema must still end up
    // requiring user_goal, not silently drop the constraint because there
    // was nothing to append to.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    server.registerTool(
      "search",
      { inputSchema: { query: z.string().optional() } },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      intentParamMode: "required",
    });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search")!;
    expect(search.inputSchema.required).toEqual(["user_goal"]);
  });

  it("intentParamMode 'off' disables injection entirely", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      intentParamMode: "off",
    });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.properties).not.toHaveProperty("user_goal");
    expect(echo.inputSchema.properties).not.toHaveProperty("expected_result");
  });

  it("throws at withBaton() time on an invalid intentParamMode", () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    expect(() =>
      withBaton(server, {
        vendorId: "acme",
        vendorDisplayName: "Acme",
        consentToken: "ct",
        sink,
        // @ts-expect-error deliberately invalid for the test
        intentParamMode: "sometimes",
      }),
    ).toThrow(/intentParamMode/);
  });
});

describe("withBaton — surface_snapshot", () => {
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
  });

  it("captures the vendor-true surface (pre-injection schemas, real instructions) on the first tool call", async () => {
    const server = new McpServer(
      { name: "vendor", version: "1.0.0" },
      { instructions: "Vendor's own instructions." },
    );
    registerTools(server); // retroactive: echo, boom
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });
    // prospective: registered after withBaton
    server.registerTool("lookup", { inputSchema: { id: z.string() } }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });

    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    expect(snapshot.payload).toMatchObject({
      server_info: { name: "vendor", version: "1.0.0" },
      // The vendor's OWN instructions — captured before withBaton
      // overwrote server.server's instructions with its own suffix.
      instructions: "Vendor's own instructions.",
    });

    if (snapshot.event_type !== "surface_snapshot") throw new Error("unreachable");
    const toolNames = snapshot.payload.tools.map((t) => (t as { name: string }).name).sort();
    // Both retroactively- and prospectively-registered tools are captured;
    // the annotate tool itself is not (it lives in seam_augmentations).
    expect(toolNames).toEqual(["boom", "echo", "lookup"]);

    const echoTool = snapshot.payload.tools.find(
      (t) => (t as { name: string }).name === "echo",
    ) as { inputSchema: { properties: Record<string, unknown> } };
    // Vendor-true — no injected params in the captured snapshot.
    expect(echoTool.inputSchema.properties).not.toHaveProperty("user_goal");
    expect(echoTool.inputSchema.properties).toHaveProperty("text");

    expect(snapshot.payload.seam_augmentations).toEqual({
      injected_tools: ["acme_annotate"],
      intent_param: {
        names: ["expected_result", "overall_task", "user_goal"],
        mode: "optional",
      },
      instructions_suffix: true,
    });
  });

  it("emits exactly once per observed hash, not once per call", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "one" } });
    await client.callTool({ name: "echo", arguments: { text: "two" } });
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});

    expect(sink.events.filter((e) => e.event_type === "surface_snapshot")).toHaveLength(1);
  });

  it("re-injects goal params after a schema-only .update() that doesn't replace the callback", async () => {
    // A .update() call can change paramsSchema without touching callback —
    // mcp.js still swaps registeredTool.inputSchema wholesale in that case,
    // wiping any previously-injected user_goal/expected_result. Since the
    // handler itself is untouched (still our wrapped closure), capture+
    // inject must re-run on schema change alone, independent of whether
    // the handler needs re-wrapping.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const echo = server.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async (args: { text: string }) => ({ content: [{ type: "text" as const, text: args.text }] }),
    );
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    echo.update({ paramsSchema: { text: z.string(), extra: z.string().optional() } });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const updated = tools.find((t) => t.name === "echo")!;
    expect(updated.inputSchema.properties).toHaveProperty("extra");
    expect(updated.inputSchema.properties).toHaveProperty("user_goal");
    expect(updated.inputSchema.properties).toHaveProperty("expected_result");
  });

  it("re-captures to the SAME hash (no duplicate emit) when a re-captured tool's schema is unchanged", async () => {
    // Distinguishes "dedup works" from "dedup happens to have been
    // exercised only once": .update()-ing a DIFFERENT tool than the one
    // whose call triggers capture forces a real second buildSnapshot() +
    // surfaceHash() run. If toJsonSchemaCompat (or canonicalJson) were
    // non-deterministic across calls, this would surface as a second,
    // differently-hashed snapshot despite nothing actually changing.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const echo = server.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async (args: { text: string }) => ({ content: [{ type: "text" as const, text: args.text }] }),
    );
    server.registerTool("boom", {}, async () => {
      throw new Error("simulated failure");
    });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});
    // Re-register "echo" with the exact same shape it already had.
    echo.update({ paramsSchema: { text: z.string() } });
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});

    const snapshots = sink.events.filter((e) => e.event_type === "surface_snapshot");
    expect(snapshots).toHaveLength(1);
  });

  it("records intent_param: null in seam_augmentations when intentParamMode is 'off'", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      intentParamMode: "off",
    });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });

    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    if (snapshot.event_type !== "surface_snapshot") throw new Error("unreachable");
    expect(snapshot.payload.seam_augmentations).toMatchObject({ intent_param: null });
  });

  it("prunes a removed tool from the next surface snapshot", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const echo = server.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async (args: { text: string }) => ({ content: [{ type: "text" as const, text: args.text }] }),
    );
    server.registerTool("boom", {}, async () => {
      throw new Error("simulated failure");
    });
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});
    echo.remove();
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});

    const snapshots = sink.events.filter((e) => e.event_type === "surface_snapshot");
    expect(snapshots).toHaveLength(2);
    if (snapshots[1]!.event_type !== "surface_snapshot") throw new Error("unreachable");
    const names = snapshots[1]!.payload.tools.map((t) => (t as { name: string }).name);
    expect(names).toEqual(["boom"]);
  });

  it("re-wraps and re-captures a tool whose callback/schema is replaced via .update()", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    let calls = 0;
    const echo = server.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async (args: { text: string }) => {
        calls += 1;
        return { content: [{ type: "text" as const, text: args.text }] };
      },
    );
    withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(calls).toBe(1);

    let newCalls = 0;
    echo.update({
      paramsSchema: { text: z.string(), extra: z.string().optional() },
      callback: async (args: { text: string; extra?: string | undefined }) => {
        newCalls += 1;
        return { content: [{ type: "text" as const, text: args.text }] };
      },
    });
    sink.events.length = 0;

    await client.callTool({ name: "echo", arguments: { text: "hi again" } });

    // The NEW callback ran (not the stale wrapped closure over the old one),
    // and it's still Baton-wrapped — still gets tool_call_start/end.
    expect(newCalls).toBe(1);
    expect(sink.events.map((e) => e.event_type)).toContain("tool_call_start");
    expect(sink.events.map((e) => e.event_type)).toContain("tool_call_end");

    // The updated schema is captured fresh too — a new (non-injected)
    // "extra" field shows up in the next surface snapshot.
    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot");
    if (snapshot && snapshot.event_type === "surface_snapshot") {
      const echoEntry = snapshot.payload.tools.find(
        (t) => (t as { name: string }).name === "echo",
      ) as { inputSchema: { properties: Record<string, unknown> } };
      expect(echoEntry.inputSchema.properties).toHaveProperty("extra");
    }
  });
});
