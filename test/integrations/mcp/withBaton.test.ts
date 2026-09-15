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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { CLIENT_INFO_META_KEY } from "../../../src/integrations/mcp/runtimeAdapter.js";
import type { BatonConfig } from "../../../src/integrations/mcp/config.js";
import { identityScrub } from "../../../src/scrub.js";
import type { Event } from "../../../src/events.js";
import type { Sink } from "../../../src/sinks.js";
import { VENDOR_HASH_SCHEME, hashPrincipalId } from "../../../src/identity.js";
import { CHATGPT_IPHONE_META } from "../../openaiMetaSamples.js";

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
    async (args: { text: string }) => ({
      content: [{ type: "text" as const, text: args.text }],
    }),
  );
  server.registerTool("boom", {}, async () => {
    throw new Error("simulated failure");
  });
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("withBaton", () => {
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
  });

  it("captures tool_call_start/end for a tool registered AFTER withBaton (prospective wrap)", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    registerTools(server);

    const client = await connectClient(server);
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    });

    expect(result.isError).toBeFalsy();
    // The first tool call on a fresh install also captures a
    // surface_snapshot (lazy — see withBaton.ts's maybeEmitSurfaceSnapshot).
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
    const [, start, end] = sink.events;
    expect(start!.payload).toMatchObject({
      tool_name: "echo",
      params: { text: "hi" },
    });
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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    });

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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      scrubber: redactStrings,
    });

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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

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

  it("keeps call_id OFF the proactive annotation it emits from the same scope", async () => {
    // The param-sourced proactive annotation is built by spreading the SAME
    // `common` object as the three tool-call legs, so `call_id` living in
    // `common` would silently stamp it — and SPEC defines no `call_id` for an
    // annotation. The emitter-conformance suite cannot see this: the
    // annotation IT captures comes from the annotation TOOL, a different
    // scope that never had a call_id to leak. This is the only place the
    // proactive path and the minted id meet.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: { text: "hi", user_goal: "find the thing" },
    });

    const annotation = sink.events.find((e) => e.event_type === "annotation")!;
    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    // The annotation really is the proactive one from batonWrap's scope...
    expect(annotation.payload).toMatchObject({ intent_source: "injected_param" });
    // ...and the call it explains really did mint an id, so a null below is
    // the stamp being withheld rather than there being nothing to stamp.
    expect(start.call_id).toEqual(expect.any(String));
    expect(annotation.call_id).toBeNull();
  });

  it("advertises overall_task on the wrapped tool's schema and never leaks it to the handler", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    let seenArgs: Record<string, unknown> | undefined;
    server.registerTool(
      "probe",
      { inputSchema: { text: z.string() } },
      (args: { text: string }) => {
        seenArgs = { ...args };
        return { content: [{ type: "text" as const, text: args.text }] };
      },
    );
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({
      name: "vendor_annotate",
      arguments: {
        user_goal: "do a thing",
        overall_task: "invoice for bob@example.com",
      },
    });

    const annotation = sink.events.find((e) => e.event_type === "annotation")!;
    // Agent sends `overall_task`; the wire carries `workflow`.
    expect(annotation.payload).toMatchObject({
      workflow: "invoice for [REDACTED:email]",
    });
  });

  it("scrubs with the default ruleset when no scrubber is configured", async () => {
    // The default is ON (`new Scrubber().scrub`), matching Python's
    // `install_baton`. This is the regression guard for that default: a
    // vendor who configures nothing must still not ship PII to the sink.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: { text: "reach me at leak@example.com" },
    });

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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({ name: "leaky", arguments: {} });

    const errorEvent = sink.events.find(
      (e) => e.event_type === "tool_call_error",
    )!;
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
    await client.callTool({
      name: "echo",
      arguments: { text: "raw@example.com" },
    });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    expect(start.payload).toMatchObject({
      params: { text: "raw@example.com" },
    });
  });

  it("drops an event whose scrubbed payload no longer matches the wire schema, fail-open", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    // Wholesale replacement breaks `params`' record shape — event
    // construction (Zod validation) fails; the tool call must still
    // succeed per SPEC §11.2 fail-open.
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      scrubber: () => "REDACTED",
    });

    const client = await connectClient(server);
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    });

    expect(result.isError).toBeFalsy();
    // tool_call_start's `params` must be a record — scrubbed to a bare
    // string, it fails Zod validation and is dropped. tool_call_end's
    // `result` has no such shape constraint (`z.unknown()`), so it still
    // gets through — the fail-open behavior is per-event, not all-or-nothing.
    // surface_snapshot is unaffected — its payload is never scrubbed (it's
    // the vendor's own static tool surface, not caller-supplied data).
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_end",
    ]);
  });

  it("throws at withBaton() time when consentToken is missing", () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    expect(() =>
      withBaton(server, {
        vendorId: "acme",
        vendorDisplayName: "Acme",
        consentToken: "",
        sink,
      }),
    ).toThrow(/consentToken/);
  });

  it("throws at withBaton() time when vendorDisplayName is missing", () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    expect(() =>
      withBaton(server, {
        vendorId: "acme",
        vendorDisplayName: "",
        consentToken: "ct",
        sink,
      }),
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

    expect(handle.annotationToolName).toBe("vendor_annotate");

    const client = await connectClient(server);
    const instructions = client.getInstructions();

    expect(instructions).toContain("vendor_annotate");
    expect(instructions).toContain("Acme");
    // Whitelabel obligation (SPEC §5.4) — no Baton-branded strings reach
    // the calling agent.
    expect(instructions?.toLowerCase()).not.toContain("baton");
  });

  it("registers a discoverable, callable annotate tool", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("vendor_annotate");

    const result = await client.callTool({
      name: "vendor_annotate",
      arguments: { user_goal: "look something up", expected_result: "a match" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("emits a proactive annotation event and does NOT emit tool_call_start/end for the annotate call itself", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({
      name: "vendor_annotate",
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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } }); // start/end noise
    sink.events.length = 0;

    await client.callTool({
      name: "vendor_annotate",
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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.callTool({
      name: "vendor_annotate",
      arguments: { user_goal: "x" },
    });

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
    expect(tools.map((t) => t.name)).not.toContain("vendor_annotate");
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

  it("injects user_goal/expected_result by default, advertising only user_goal as required", async () => {
    // The default moved from "optional" to "required" on 2026-09-15, so the
    // advertised `required` gains `user_goal` (and only it). Enforcement is
    // unchanged: see "intentParamMode 'required' does NOT refuse" below.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;

    expect(echo.inputSchema.properties).toHaveProperty("user_goal");
    expect(echo.inputSchema.properties).toHaveProperty("expected_result");
    expect(echo.inputSchema.required).toEqual(["text", "user_goal"]);
  });

  it("does not add a schema to a tool registered with none (zero-arg tools are left alone)", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

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
        return {
          content: [{ type: "text" as const, text: String(args.text) }],
        };
      },
    );
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        user_goal: "find the invoice",
        expected_result: "a total",
      },
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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: { text: "one", user_goal: "goal one" },
    });
    await client.callTool({
      name: "echo",
      arguments: { text: "two", user_goal: "goal two" },
    });

    expect(
      sink.events.filter((e) => e.event_type === "annotation"),
    ).toHaveLength(1);
    // The second call's start event still carries its own call_intent even
    // though it didn't open a new proactive.
    const starts = sink.events.filter(
      (e) => e.event_type === "tool_call_start",
    );
    expect(starts.map((e) => e.payload.call_intent)).toEqual([
      "goal one",
      "goal two",
    ]);
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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({
      name: "search",
      arguments: { user_goal: "the vendor's own field" },
    });

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
    expect(start.payload).toMatchObject({
      call_intent: null,
      intent_source: null,
    });
  });

  // 2026-09-01 (D7). These two tests asserted the OPPOSITE until today: that
  // `required` put `user_goal` into the vendor's own required array. It did,
  // and the consequence was that an agent omitting the param had its call
  // refused by the VENDOR'S server — Baton breaking a customer's product to
  // collect a telemetry string. `required` now means what it means in the
  // proxy: never enforced.
  it("intentParamMode 'required' does NOT refuse a call that omits user_goal", async () => {
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
    // The behaviour that matters, asserted through a real client: the call is
    // SERVED. Before today this rejected, naming `user_goal`.
    const res = (await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("hi");

    // And the vendor's own constraint is untouched — dropping OUR enforcement
    // must not drop THEIRS.
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.required).toContain("text");
  });

  it("intentParamMode 'required' advertises user_goal as required, and nothing else changes", async () => {
    // Flipped 2026-09-15. This test used to pin the opposite: that the two
    // modes advertised the same schema, because this package had no
    // `tools/list` hook and zod cannot advertise a field it does not enforce.
    // The hook exists now (`installToolsListSeam` in withBaton.ts) and edits
    // the RESPONSE, never the zod schema, which is why the test above this one
    // still holds: the omitting call is served.
    const advertised = async (mode: "optional" | "required") => {
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
        intentParamMode: mode,
      });
      const client = await connectClient(server);
      const { tools } = await client.listTools();
      return tools.find((t) => t.name === "search")!.inputSchema;
    };

    const asOptional = await advertised("optional");
    const asRequired = await advertised("required");
    expect(asOptional.required).toBeUndefined();
    expect(asRequired.required).toEqual(["user_goal"]);

    // Apart from `required`, the only difference is the label on user_goal's
    // own description, which names the mode.
    type Advertised = typeof asRequired;
    const properties = (s: Advertised) => s.properties as Record<string, { description?: string }>;
    expect(properties(asRequired).user_goal!.description).toMatch(/^REQUIRED\. /);
    expect(properties(asOptional).user_goal!.description).toMatch(/^OPTIONAL\. /);
    const unlabelled = (s: Advertised) => ({
      ...s,
      required: undefined,
      properties: {
        ...properties(s),
        user_goal: { ...properties(s).user_goal, description: undefined },
      },
    });
    expect(unlabelled(asRequired)).toEqual(unlabelled(asOptional));
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

  it("refuses the pre-0.3.5 identity keys rather than ignoring them", () => {
    // A JavaScript caller gets no compile error, and identity fails open, so an
    // ignored key would silently stop producing principal_id.
    for (const [was, now] of [
      ["resolveUser", "resolvePrincipal"],
      ["userIdMode", "principalIdMode"],
      ["userIdHmacKey", "principalIdHmacKey"],
    ] as const) {
      const server = new McpServer({ name: "vendor", version: "1.0.0" });
      const config = { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink, [was]: "x" };
      expect(() => withBaton(server, config as never)).toThrow(`BatonConfig.${was} was renamed to ${now}`);
    }
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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    // prospective: registered after withBaton
    server.registerTool(
      "lookup",
      { inputSchema: { id: z.string() } },
      async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    );

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });

    const snapshot = sink.events.find(
      (e) => e.event_type === "surface_snapshot",
    )!;
    expect(snapshot.payload).toMatchObject({
      server_info: { name: "vendor", version: "1.0.0" },
      // The vendor's OWN instructions — captured before withBaton
      // overwrote server.server's instructions with its own suffix.
      instructions: "Vendor's own instructions.",
    });

    if (snapshot.event_type !== "surface_snapshot")
      throw new Error("unreachable");
    const toolNames = snapshot.payload.tools
      .map((t) => (t as { name: string }).name)
      .sort();
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
      injected_tools: ["vendor_annotate"],
      intent_param: {
        names: ["expected_result", "overall_task", "user_goal"],
        // The default since 2026-09-15; this install sets no mode.
        mode: "required",
      },
      instructions_suffix: true,
    });
  });

  it("emits exactly once per observed hash, not once per call", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "one" } });
    await client.callTool({ name: "echo", arguments: { text: "two" } });
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});

    expect(
      sink.events.filter((e) => e.event_type === "surface_snapshot"),
    ).toHaveLength(1);
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
      async (args: { text: string }) => ({
        content: [{ type: "text" as const, text: args.text }],
      }),
    );
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    echo.update({
      paramsSchema: { text: z.string(), extra: z.string().optional() },
    });

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
      async (args: { text: string }) => ({
        content: [{ type: "text" as const, text: args.text }],
      }),
    );
    server.registerTool("boom", {}, async () => {
      throw new Error("simulated failure");
    });
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});
    // Re-register "echo" with the exact same shape it already had.
    echo.update({ paramsSchema: { text: z.string() } });
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});

    const snapshots = sink.events.filter(
      (e) => e.event_type === "surface_snapshot",
    );
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

    const snapshot = sink.events.find(
      (e) => e.event_type === "surface_snapshot",
    )!;
    if (snapshot.event_type !== "surface_snapshot")
      throw new Error("unreachable");
    expect(snapshot.payload.seam_augmentations).toMatchObject({
      intent_param: null,
    });
  });

  it("prunes a removed tool from the next surface snapshot", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    const echo = server.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async (args: { text: string }) => ({
        content: [{ type: "text" as const, text: args.text }],
      }),
    );
    server.registerTool("boom", {}, async () => {
      throw new Error("simulated failure");
    });
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

    const client = await connectClient(server);
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});
    echo.remove();
    await client.callTool({ name: "boom", arguments: {} }).catch(() => {});

    const snapshots = sink.events.filter(
      (e) => e.event_type === "surface_snapshot",
    );
    expect(snapshots).toHaveLength(2);
    if (snapshots[1]!.event_type !== "surface_snapshot")
      throw new Error("unreachable");
    const names = snapshots[1]!.payload.tools.map(
      (t) => (t as { name: string }).name,
    );
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
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });

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
    const snapshot = sink.events.find(
      (e) => e.event_type === "surface_snapshot",
    );
    if (snapshot && snapshot.event_type === "surface_snapshot") {
      const echoEntry = snapshot.payload.tools.find(
        (t) => (t as { name: string }).name === "echo",
      ) as { inputSchema: { properties: Record<string, unknown> } };
      expect(echoEntry.inputSchema.properties).toHaveProperty("extra");
    }
  });
});

describe("withBaton — tenant_id is the ACCOUNT, not a second copy of vendor_id", () => {
  // The bug this closes: every envelope shipped `tenant_id: config.vendorId`,
  // so one account's several servers collapsed into one. Mirrors the Python
  // half (`aea84a8`) — resolution order, the falsy-means-unset rule, and the
  // once-per-install rule that keeps an annotation joinable to its call.
  // `BATON_TENANT_ID` is cleared before every test globally (`test/setup.ts`),
  // so each case here sets exactly the environment it means to assert about.
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
  });

  async function eventsFor(config: Partial<BatonConfig>): Promise<Event[]> {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, {
      vendorId: "echo-server",
      vendorDisplayName: "Echo",
      consentToken: "ct",
      sink,
      ...config,
    });
    registerTools(server);
    const client = await connectClient(server);
    // One of each emitting path: surface_snapshot (built from `config`
    // directly, so it is the site that drifts), tool_call_start/end (via
    // `ctx`), and annotation (via registerAnnotationTool's own options).
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.callTool({
      name: "vendor_annotate",
      arguments: { user_goal: "g", expected_result: "r", overall_task: "t" },
    });
    return sink.events;
  }

  it("puts an explicit tenantId on EVERY event type, and never in vendor_id", async () => {
    const events = await eventsFor({ tenantId: "ten_7cd4c8cf" });

    expect(events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
      "annotation",
    ]);
    // Asserted per event, not on a sample: `emitSurface` builds its envelope
    // from `config` rather than from `ctx`, so a fix applied only to the
    // wrapper leaves the snapshot behind — under the OLD tenant, in the same
    // session as calls under the new one.
    for (const event of events) {
      expect(event.tenant_id).toBe("ten_7cd4c8cf");
      expect(event.vendor_id).toBe("echo-server");
    }
  });

  it("reads BATON_TENANT_ID when no tenantId is configured", async () => {
    process.env.BATON_TENANT_ID = "ten_fromenv";
    const events = await eventsFor({});
    for (const event of events) expect(event.tenant_id).toBe("ten_fromenv");
  });

  it("prefers an explicit tenantId over BATON_TENANT_ID", async () => {
    process.env.BATON_TENANT_ID = "ten_fromenv";
    const events = await eventsFor({ tenantId: "ten_explicit" });
    for (const event of events) expect(event.tenant_id).toBe("ten_explicit");
  });

  it("treats an empty tenantId as unset, matching Python's `if explicit:`", async () => {
    // `??` would ship a blank tenant here and `||` does not. The wire schema
    // accepts any string, so nothing downstream of this test catches it.
    process.env.BATON_TENANT_ID = "ten_fromenv";
    const events = await eventsFor({ tenantId: "" });
    for (const event of events) expect(event.tenant_id).toBe("ten_fromenv");
  });

  it("falls back to vendorId — the migration shim, pinned so deleting it is deliberate", async () => {
    // Not a supported configuration: it reproduces exactly the collapse this
    // split exists to end. It is here for our own fixtures mid-change, and
    // this test is what makes its removal a decision rather than an accident.
    const events = await eventsFor({});
    for (const event of events) expect(event.tenant_id).toBe("echo-server");
  });

  it("resolves at INSTALL time, not per event — the env changing mid-session moves nothing", async () => {
    // The discriminating case. Asserting one tenant across a session with a
    // constant environment proves nothing: resolution moved into the emit
    // path would re-read the same value and stay green. Two independent
    // resolutions CAN disagree, and the failure is silent — it lands
    // downstream as an annotation the Console cannot attach to any call.
    process.env.BATON_TENANT_ID = "ten_a";
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, {
      vendorId: "echo-server",
      vendorDisplayName: "Echo",
      consentToken: "ct",
      sink,
    });
    registerTools(server);
    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });

    // Same install, same session, different environment.
    process.env.BATON_TENANT_ID = "ten_b";
    await client.callTool({
      name: "vendor_annotate",
      arguments: { user_goal: "g", expected_result: "r", overall_task: "t" },
    });

    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
      "annotation",
    ]);
    expect(new Set(sink.events.map((e) => e.tenant_id))).toEqual(new Set(["ten_a"]));
  });
});

/**
 * The agent-runtime ladder against the REAL 1.x peer.
 *
 * Nothing in this file asserted `agent_runtime` before — the ladder's only
 * coverage on this major was a unit test over hand-built dicts, which is the
 * shape that let a wrong `except` tuple ship once already. The carriers here
 * are two third-party objects; these run against them.
 */
describe("withBaton — agent_runtime, against the real 1.x peer", () => {
  let sink: CapturingSink;
  beforeEach(() => {
    sink = new CapturingSink();
  });

  async function runtimeFor(meta?: Record<string, unknown>): Promise<string> {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    const client = await connectClient(server);
    await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
      ...(meta ? { _meta: meta } : {}),
    });
    return sink.events.find((e) => e.event_type === "tool_call_start")!.agent_runtime;
  }

  it("tier 2: reports the name the client declared in its handshake", async () => {
    // This is the tier that answers for every client shipping today. The
    // carrier is NOT the handler context — neither peer puts client identity
    // there — it is `McpServer.server.getClientVersion()`, measured live on
    // sdk 1.30.0 and server 2.0.0. `vendor` is the SERVER's name, which is
    // what a tier-2 wired to the wrong object would report.
    expect(await runtimeFor()).toBe("test-client");
  });

  it("tier 1: a request-borne declaration outranks the handshake", async () => {
    // On 1.x the reserved key stays in `_meta`. On v2 it does NOT — it is
    // lifted to `mcpReq.envelope` — which is why the same assertion lives in
    // `withBatonV2.test.ts` too and why reading one location is a silent
    // `unknown` across a whole major.
    expect(
      await runtimeFor({ [CLIENT_INFO_META_KEY]: { name: "gateway-declared", version: "1" } }),
    ).toBe("gateway-declared");
  });

  it("ignores a defaultAgentRuntime a caller still passes", async () => {
    // The removal is an ABSENCE, and deleting the field reddened nothing —
    // same fact as the override removal this file's sibling exists for. TS
    // refuses the key at compile time, so the shape that can still reach us
    // is a JS consumer (or an `as` cast) carrying it across an upgrade: it
    // must be inert, not quietly beat a client that named itself.
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    registerTools(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
      defaultAgentRuntime: "acme-runtime",
    } as Parameters<typeof withBaton>[1]);

    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    expect(start.agent_runtime).toBe("test-client");
    // Including where the ladder is deliberately not consulted: `unknown` is
    // the SDK's literal, not a value a vendor can substitute. The surface
    // snapshot is the one event that takes the literal unconditionally, so
    // it is where a resurrected knob would show up first.
    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    expect(snapshot.agent_runtime).toBe("unknown");
  });

  it("tier 3: the claudecode/* heuristic is BELOW both declarations", async () => {
    // A proxy forwards `_meta` verbatim, so `claudecode/*` says where the
    // metadata came from, not who the caller is. The client here declares
    // `test-client` and sends a Claude Code key; the declaration wins.
    expect(await runtimeFor({ "claudecode/toolUseId": "tu_1" })).toBe("test-client");
  });
});

/**
 * Handoff D5 through the real wrap: `_meta`'s latitude and longitude are
 * rounded to 1 decimal on the way to runtime_meta, by `roundMetaCoordinates`
 * ahead of the scrubber. `_meta` only: a tool's own coordinates in its params
 * or result are captured at full precision.
 */
describe("withBaton — coordinates in runtime_meta", () => {
  let sink: CapturingSink;
  beforeEach(() => {
    sink = new CapturingSink();
  });

  const ROUNDED_IPHONE_LOCATION = {
    ...CHATGPT_IPHONE_META["openai/userLocation"],
    latitude: "37.8",
    longitude: "-122.4",
  };

  async function connect(register: (server: McpServer) => void = registerTools): Promise<Client> {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    register(server);
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink,
    });
    return connectClient(server);
  }

  it("runtime_meta carries rounded coordinates; agent_runtime still reads the raw meta", async () => {
    // The request declares `openai-mcp`, so that name (not the handshake's
    // `test-client`) proves the ladder ran on this very meta.
    const client = await connect();
    const meta = {
      ...CHATGPT_IPHONE_META,
      [CLIENT_INFO_META_KEY]: { name: "openai-mcp", version: "1.0.0" },
    };
    await client.callTool({ name: "echo", arguments: { text: "hi" }, _meta: meta });

    const legs = sink.events.filter(
      (e) => e.event_type === "tool_call_start" || e.event_type === "tool_call_end",
    );
    expect(legs).toHaveLength(2);
    for (const e of legs) {
      expect(e.agent_runtime).toBe("openai-mcp");
      expect(e.runtime_meta).toEqual({ ...meta, "openai/userLocation": ROUNDED_IPHONE_LOCATION });
    }
  });

  it("captures a tool's own latitude param and result unchanged", async () => {
    const client = await connect((server) => {
      server.registerTool(
        "locate",
        { inputSchema: { latitude: z.string() } },
        async (args: { latitude: string }) => ({
          content: [{ type: "text" as const, text: args.latitude }],
        }),
      );
    });
    await client.callTool({
      name: "locate",
      arguments: { latitude: "37.79535123456789" },
      _meta: CHATGPT_IPHONE_META,
    });

    const start = sink.events.find((e) => e.event_type === "tool_call_start")!;
    const end = sink.events.find((e) => e.event_type === "tool_call_end")!;
    expect(start.payload).toMatchObject({ params: { latitude: "37.79535123456789" } });
    expect(JSON.stringify(end.payload)).toContain('"37.79535123456789"');
    // ...while the same call's `_meta` was rounded, so the rule did run.
    expect(start.runtime_meta?.["openai/userLocation"]).toEqual(ROUNDED_IPHONE_LOCATION);
  });

  it("the annotation tool's runtime_meta carries rounded coordinates too", async () => {
    const client = await connect();
    await client.callTool({
      name: "vendor_annotate",
      arguments: { user_goal: "find the thing" },
      _meta: CHATGPT_IPHONE_META,
    });

    const annotation = sink.events.find((e) => e.event_type === "annotation")!;
    expect(annotation.runtime_meta).toEqual({
      ...CHATGPT_IPHONE_META,
      "openai/userLocation": ROUNDED_IPHONE_LOCATION,
    });
  });
});

// ---------------------------------------------------------------------------
// `principal_id` (register D6) — the field existed on this SDK's envelope since
// 0.3.0 with NOTHING able to populate it. These drive the real wrap so the
// assertion is about what reaches the sink, not about the resolver in
// isolation (that is `principalResolution.test.ts`).
// ---------------------------------------------------------------------------

describe("withBaton principal_id", () => {
  const TENANT = "tenant-e2e";
  const KEY = "e2e-identity-key";

  // ⚠ `resolvePrincipalIdHmacKey` falls back to `BATON_PRINCIPAL_ID_HMAC_KEY`, the
  // variable vendors are told to export for hashed identity. On a
  // machine or CI job that has it set, the "no key" test below would see a
  // REAL hash and fail for a reason unrelated to the code. Cleared for this
  // block so the assertions depend on the config, not on the environment.
  beforeEach(() => {
    vi.stubEnv("BATON_PRINCIPAL_ID_HMAC_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function drive(
    sink: CapturingSink,
    config: Partial<Parameters<typeof withBaton>[1]> = {},
  ): Promise<Event[]> {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      tenantId: TENANT,
      sink,
      ...config,
    });
    registerTools(server);
    const client = await connectClient(server);
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.callTool({
      name: "vendor_annotate",
      arguments: { user_goal: "look up", signal_type: "failure" },
    });
    return sink.events;
  }

  it("is null on every event when no hook is configured", async () => {
    const events = await drive(new CapturingSink());
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.principal_id).toBeNull();
  });

  it("reaches the tool-call legs AND the annotation tool from one hook", async () => {
    // The split that matters: an annotation naming a different actor than the
    // call it describes is unjoinable downstream. Both paths, one hook, one
    // resolution — and asserted on the EXPECTED hash, so two paths that are
    // both broken to null cannot pass by agreeing.
    const expected = hashPrincipalId("employee-4417", {
      tenantId: TENANT,
      key: KEY,
      scheme: VENDOR_HASH_SCHEME,
    });
    const events = await drive(new CapturingSink(), {
      resolvePrincipal: () => ({ principalId: "employee-4417" }),
      principalIdHmacKey: KEY,
    });

    const carriers = events.filter((e) => e.event_type !== "surface_snapshot");
    expect(carriers.length).toBeGreaterThan(1);
    for (const event of carriers) expect(event.principal_id).toBe(expected);

    const annotations = carriers.filter((e) => e.event_type === "annotation");
    expect(annotations.length).toBeGreaterThan(0);
  });

  it("never lets a vendor's broken hook fail the vendor's tool call", async () => {
    const sink = new CapturingSink();
    const events = await drive(sink, {
      resolvePrincipal: () => {
        throw new Error("vendor bug");
      },
      principalIdHmacKey: KEY,
    });
    // The call still succeeded and still emitted; identity is simply absent.
    expect(events.some((e) => e.event_type === "tool_call_end")).toBe(true);
    for (const event of events) expect(event.principal_id).toBeNull();
  });

  it("drops the field in hashed mode with no key rather than emitting it raw", async () => {
    // A residency breach that looked like success would be: field present,
    // populated, carrying the subject verbatim.
    const events = await drive(new CapturingSink(), {
      resolvePrincipal: () => ({ principalId: "alice@acme.example" }),
    });
    for (const event of events) {
      expect(event.principal_id).toBeNull();
      expect(JSON.stringify(event)).not.toContain("alice@acme.example");
    }
  });

  it("emits the subject verbatim in raw mode", async () => {
    const events = await drive(new CapturingSink(), {
      resolvePrincipal: () => ({ principalId: "alice@acme.example" }),
      principalIdMode: "raw",
    });
    const carriers = events.filter((e) => e.event_type !== "surface_snapshot");
    for (const event of carriers) expect(event.principal_id).toBe("alice@acme.example");
  });

  it("never stamps principal_id on a surface_snapshot", async () => {
    // It describes the SERVER and is captured outside any call, so there is
    // no caller to name (Python register D5).
    const events = await drive(new CapturingSink(), {
      resolvePrincipal: () => ({ principalId: "employee-4417" }),
      principalIdHmacKey: KEY,
    });
    for (const event of events.filter((e) => e.event_type === "surface_snapshot")) {
      expect(event.principal_id).toBeNull();
    }
  });
});
