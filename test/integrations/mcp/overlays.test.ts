/** Overlays from the settings document (SPEC §2.6), on both majors. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CaptureSettings, parseDocument } from "../../../src/integrations/mcp/captureSettings.js";
import { PerCallerSurface } from "../../../src/integrations/mcp/perCaller.js";
import { INTENT_INSTRUCTIONS, buildRefusalText } from "../../../src/integrations/mcp/llmText.js";
import { changedText } from "../../../src/integrations/mcp/overlays.js";
import { SentSurfaces } from "../../../src/integrations/mcp/surface.js";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { MAJORS, type Major, lowLevelServerOf } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

const WORKSPACE = "ten_655b084e118b43f88992ee6357fcc23c";
const DSN = `https://baton_pk_${"a".repeat(43)}@ingest.example.com/${WORKSPACE}/srv`;
const GOAL = "1: book a slot; success is a booking id";

// The Console's sample document, with `beta` matched by client so a test can pick its audience.
const SAMPLE = {
  version: 9,
  audiences: [
    {
      id: "beta",
      match: { client: ["claude-code"] },
      capture: { goal: "required", reports: "on", results: "full" },
      overlay: "ov_beta_1",
    },
    { id: "everyone", match: {}, capture: { goal: "required", reports: "on", results: "off" } },
  ],
  overlays: {
    ov_beta_1: {
      actions: [
        { target: { tool: "book_slot" }, replace: "Books one slot. Check availability first." },
        { target: { tool: "find_slots" }, append: "Returns at most 20 slots." },
        { target: { tool: "legacy_book" }, remove: true },
        { target: { tool: "book_slot", param: "timezone" }, append: "Use an IANA name, such as Europe/Paris." },
        { target: { tool: "book_slot", param: "notes" }, remove: true },
        { target: { tool: "find_slots", param: "duration" }, required: true },
        { target: { tool: "find_slots", param: "day" }, replace: "The day, as YYYY-MM-DD." },
        { target: { agent_text: "goal_param.description" }, replace: "What the user wants, in their words." },
        { target: { agent_text: "report_tool.description" }, append: "Use it when a booking fails twice." },
        { target: { agent_text: "report_tool.refusal" }, replace: "Reports are off for now." },
      ],
    },
    ov_server_1: {
      actions: [
        { target: { instructions: true }, append: "Times are in the user's timezone." },
        {
          target: { agent_text: "instructions.report_pointer" },
          replace: "If a booking keeps failing, say so with the report tool.",
        },
        { target: { agent_text: "instructions.subagent" }, append: "Pass the user's timezone to subagents." },
      ],
    },
  },
  server_overlay: "ov_server_1",
};

const sample = (): any => structuredClone(SAMPLE);

interface Collector {
  events: Record<string, any>[];
  document: string | null;
  reads: number;
}

function useCollector(document: unknown): Collector {
  const collector: Collector = { events: [], document: document === null ? null : JSON.stringify(document), reads: 0 };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("/v0/settings")) {
      collector.reads++;
      return collector.document === null
        ? new Response(null, { status: 204 })
        : new Response(collector.document, { status: 200 });
    }
    const body = JSON.parse(init.body as string) as { events?: Record<string, unknown>[] };
    collector.events.push(...(body.events ?? [body]));
    return new Response(null, { status: 202 });
  });
  return collector;
}

function bookingServer(major: Major): any {
  const server = major.make();
  major.tool(server, "book_slot", { day: z.string(), timezone: z.string(), notes: z.string().optional() }, (args) => ({
    content: [{ type: "text" as const, text: `booked ${args.day}` }],
  }));
  major.tool(server, "find_slots", { day: z.string(), duration: z.number().optional() }, (args) => ({
    content: [{ type: "text" as const, text: `slots on ${args.day}` }],
  }));
  major.tool(server, "legacy_book", { day: z.string() }, (args) => ({
    content: [{ type: "text" as const, text: `legacy ${args.day}` }],
  }));
  return server;
}

interface Seen {
  tools: Record<string, any>;
  calls: Record<string, { result?: any; error?: string }>;
  instructions: string;
}

const CALLS: Record<string, [string, Record<string, unknown>]> = {
  book: ["book_slot", { day: "mon", timezone: "UTC", user_goal: GOAL }],
  legacy: ["legacy_book", { day: "mon", user_goal: GOAL }],
  missing: ["ghost_book", { day: "mon", user_goal: GOAL }],
  find: ["find_slots", { day: "mon", user_goal: GOAL }],
  refused: ["srv_annotate", { user_goal: GOAL }],
};

async function call(client: any, name: string, args: Record<string, unknown>): Promise<{ result?: any; error?: string }> {
  try {
    return { result: await client.callTool({ name, arguments: args }) };
  } catch (err) {
    return { error: String(err) };
  }
}

/** One connection per client name: list the tools, make each call. */
async function drive(
  major: Major,
  document: unknown,
  clients: string[],
  config: Record<string, unknown> = {},
): Promise<{ seen: Seen[]; events: Record<string, any>[] }> {
  const collector = useCollector(document);
  const server = bookingServer(major);
  const handle = withBaton(server, {
    dsn: DSN,
    vendorDisplayName: "Server",
    settings: document === undefined ? "local" : "console",
    annotationToolName: "srv_annotate",
    ...config,
  });
  const seen: Seen[] = [];
  try {
    if (document !== undefined) await vi.waitFor(() => expect(collector.reads).toBeGreaterThan(0));
    await new Promise((resolve) => setImmediate(resolve));
    for (const clientName of clients) {
      const client = await major.connect(server, { clientName });
      const { tools } = await client.listTools();
      const calls: Seen["calls"] = {};
      for (const [key, [name, args]] of Object.entries(CALLS)) calls[key] = await call(client, name, { ...args });
      seen.push({
        tools: Object.fromEntries((tools as { name: string }[]).map((tool) => [tool.name, tool])),
        calls,
        instructions: client.getInstructions() as string,
      });
      await client.close();
    }
  } finally {
    await handle.flush();
    await handle.aclose();
  }
  return { seen, events: collector.events };
}

const props = (seen: Seen, tool: string) => seen.tools[tool].inputSchema.properties;
const required = (seen: Seen, tool: string): string[] => seen.tools[tool].inputSchema.required ?? [];
const text = (outcome: { result?: any; error?: string }): string => outcome.error ?? outcome.result.content[0].text;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(MAJORS)("$label", (major) => {
  it("two callers in different audiences see different tool lists", async () => {
    const { seen: [beta, other] } = await drive(major, sample(), ["claude-code", "cursor"]);
    expect(beta!.tools.legacy_book).toBeUndefined();
    expect(other!.tools.legacy_book).toBeDefined();
    expect(beta!.tools.book_slot.description).toBe("Books one slot. Check availability first.");
    expect(other!.tools.book_slot.description).toBeUndefined();
    expect(beta!.tools.find_slots.description).toBe("Returns at most 20 slots.");
    expect(props(beta!, "book_slot").timezone.description).toBe("Use an IANA name, such as Europe/Paris.");
    expect(props(beta!, "book_slot").notes).toBeUndefined();
    expect(props(other!, "book_slot").notes).toBeDefined();
    expect(props(beta!, "find_slots").day.description).toBe("The day, as YYYY-MM-DD.");
    expect(required(beta!, "find_slots")).toContain("duration");
    expect(required(other!, "find_slots")).not.toContain("duration");
    for (const tool of ["book_slot", "find_slots"]) {
      expect(props(beta!, tool).user_goal.description).toBe("What the user wants, in their words.");
      expect(props(other!, tool).user_goal.description).toMatch(/^REQUIRED\./);
    }
    expect(beta!.tools.srv_annotate.description).toMatch(/\n\nUse it when a booking fails twice\.$/);
    expect(other!.tools.srv_annotate.description).not.toMatch(/fails twice\.$/);
  });

  it("a hidden tool answers as a missing one", async () => {
    const { seen: [beta, other], events } = await drive(major, sample(), ["claude-code", "cursor"]);
    expect(beta!.calls.legacy).toEqual(
      JSON.parse(JSON.stringify(beta!.calls.missing).replaceAll("ghost_book", "legacy_book")),
    );
    expect(text(beta!.calls.legacy!)).toMatch(/Tool legacy_book not found/);
    expect(text(other!.calls.legacy!)).toBe("legacy mon");

    const hidden = events.filter((e) => e.event_type === "tool_call_error" && e.payload.tool_name === "legacy_book");
    expect(hidden).toHaveLength(1);
    const [error] = hidden;
    expect(error!.payload.failure_kind).toBe("tool_hidden");
    expect(text(beta!.calls.legacy!)).toContain(error!.payload.error_body);
    expect(error!.capture).toEqual({ settings_version: 9, audience: "beta", overlay: "ov_beta_1" });
    const start = events.find((e) => e.event_type === "tool_call_start" && e.call_id === error!.call_id);
    expect(start!.payload.call_intent).toBe(GOAL);
    expect(start!.payload.params).not.toHaveProperty("user_goal");
  });

  it("a tool the server lacks is unknown, whatever the overlay says", async () => {
    const document = sample();
    document.overlays.ov_beta_1.actions.push({ target: { tool: "ghost_book" }, remove: true });
    const { events } = await drive(major, document, ["claude-code"]);
    const [error] = events.filter((e) => e.event_type === "tool_call_error" && e.payload.tool_name === "ghost_book");
    expect(error!.payload.failure_kind).toBe("unknown_tool");
  });

  it("a param listed as required is not enforced", async () => {
    const { seen: [beta] } = await drive(major, sample(), ["claude-code"]);
    expect(required(beta!, "find_slots")).toContain("duration");
    expect(text(beta!.calls.find!)).toBe("slots on mon");
  });

  it("every event in an audience with an overlay carries it", async () => {
    const { events } = await drive(major, sample(), ["claude-code"]);
    const perCall = events.filter((e) => e.event_type !== "surface_snapshot");
    expect(perCall.length).toBeGreaterThan(0);
    for (const event of perCall) expect(event.capture?.overlay, event.event_type).toBe("ov_beta_1");
  });

  it("the server overlay is in the instructions", async () => {
    const { seen: [beta] } = await drive(major, sample(), ["claude-code"]);
    expect(beta!.instructions).toBe(
      "Times are in the user's timezone.\n\n" +
        "If a booking keeps failing, say so with the report tool.\n\n" +
        `${INTENT_INSTRUCTIONS}\n\nPass the user's timezone to subagents.`,
    );
  });

  it("instruction text is trimmed and an empty replace removes it", async () => {
    const document = sample();
    document.overlays.ov_server_1.actions = [
      { target: { instructions: true }, append: "Times are local.\n" },
      { target: { agent_text: "instructions.subagent" }, replace: "" },
    ];
    const { seen: [beta] } = await drive(major, document, ["claude-code"]);
    expect(beta!.instructions.startsWith("Times are local.\n\nUse `")).toBe(true);
    expect(beta!.instructions).not.toContain("\n\n\n");
    expect(beta!.instructions).not.toContain(INTENT_INSTRUCTIONS);
  });

  it("the snapshot names the server overlay", async () => {
    const { events } = await drive(major, sample(), ["claude-code"]);
    const snapshots = events.filter((e) => e.event_type === "surface_snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.payload.seam_augmentations.server_overlay).toBe("ov_server_1");
    const agentText = snapshots[0]!.payload.seam_augmentations.agent_text;
    expect(agentText["instructions.report_pointer"]).toEqual({
      text: "If a booking keeps failing, say so with the report tool.",
      source: "replaced",
    });
    expect(agentText["instructions.subagent"]).toEqual({
      text: `${INTENT_INSTRUCTIONS}\n\nPass the user's timezone to subagents.`,
      source: "appended",
    });
    expect(agentText["report_tool.description"].source).toBe("default");
  });

  it("with no server overlay the snapshot sends null", async () => {
    const document = sample();
    delete document.server_overlay;
    const { events } = await drive(major, document, ["claude-code"]);
    const [snapshot] = events.filter((e) => e.event_type === "surface_snapshot");
    expect(snapshot!.payload.seam_augmentations.server_overlay).toBeNull();
  });

  it("without console settings the snapshot leaves server_overlay out", async () => {
    const { events } = await drive(major, undefined, ["claude-code"]);
    const [snapshot] = events.filter((e) => e.event_type === "surface_snapshot");
    expect(snapshot!.payload.seam_augmentations).not.toHaveProperty("server_overlay");
  });

  it("the refusal follows the caller's overlay", async () => {
    const { seen: [beta, other] } = await drive(major, sample(), ["claude-code", "cursor"]);
    expect(text(beta!.calls.refused!)).toContain("Reports are off for now.");
    expect(text(other!.calls.refused!)).toContain("reactive-only");
  });

  it("an action that cannot apply is skipped alone", async () => {
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const document = sample();
    // Per major: each action warns once per process.
    const id = `ov_skips_${major.label}`;
    document.audiences[0].overlay = id;
    document.overlays[id] = {
      actions: [
        { target: { tool: "nope" }, append: "x" },
        { target: { tool: "book_slot", param: "day" }, remove: true },
        { target: { instructions: true }, append: "server only" },
        { target: { tool: "book_slot", param: "notes" }, remove: true },
      ],
    };
    const { seen: [beta] } = await drive(major, document, ["claude-code"]);
    expect(props(beta!, "book_slot").day).toBeDefined();
    expect(props(beta!, "book_slot").notes).toBeUndefined();
    const skipped = warnings.mock.calls.map(([message]) => String(message)).filter((m) => m.includes("is skipped"));
    expect(skipped.some((m) => m.includes('no tool is named "nope"'))).toBe(true);
    expect(skipped.some((m) => m.includes('requires "day"'))).toBe(true);
    expect(skipped.some((m) => m.includes("goes only in server_overlay"))).toBe(true);
  });

  it("checking for a hidden tool asks the hook once per call", async () => {
    const asked: string[] = [];
    await drive(major, sample(), ["cursor"], {
      resolvePrincipal: (context: { toolName?: string }) => {
        if (context.toolName !== undefined) asked.push(context.toolName);
        return null;
      },
    });
    expect(asked.filter((name) => name === "legacy_book")).toHaveLength(1);
  });

  it("a low-level Server hides a tool on tools/call too", async () => {
    const collector = useCollector(sample());
    const { server, listTools, callTool } = lowLevelServerOf(major);
    server.setRequestHandler(listTools, () => ({
      tools: [{ name: "legacy_book", inputSchema: { type: "object", properties: { day: { type: "string" } } } }],
    }));
    server.setRequestHandler(callTool, () => ({ content: [{ type: "text", text: "legacy mon" }] }));
    const handle = withBaton(server, { dsn: DSN, settings: "console" });
    try {
      await vi.waitFor(() => expect(collector.reads).toBeGreaterThan(0));
      await new Promise((resolve) => setImmediate(resolve));
      const client = await major.connect(server, { clientName: "claude-code" });
      const listed = ((await client.listTools()).tools as { name: string }[]).map((tool) => tool.name);
      expect(listed).not.toContain("legacy_book");
      const answer = await call(client, "legacy_book", { day: "mon", user_goal: GOAL });
      expect(text(answer)).toMatch(/Tool legacy_book not found/);
      await client.close();
    } finally {
      await handle.flush();
      await handle.aclose();
    }
    const [error] = collector.events.filter((e) => e.event_type === "tool_call_error");
    expect(error!.payload.failure_kind).toBe("tool_hidden");
    const start = collector.events.find((e) => e.event_type === "tool_call_start" && e.call_id === error!.call_id);
    expect(start!.payload.call_intent).toBe(GOAL);
    expect(start!.payload.params).toEqual({ day: "mon" });
  });

  /** A low-level Server listing `legacy_book` with `schema`, or listing nothing
   * without one; returns the events and what the hook saw. */
  async function lowLevelCall(
    clientName: string,
    schema: Record<string, unknown> | undefined,
    args: Record<string, unknown>,
  ): Promise<{ events: Record<string, any>[]; asked: Record<string, unknown>[] }> {
    const collector = useCollector(sample());
    const { server, listTools, callTool } = lowLevelServerOf(major);
    if (schema !== undefined) {
      server.setRequestHandler(listTools, () => ({ tools: [{ name: "legacy_book", inputSchema: schema }] }));
    }
    server.setRequestHandler(callTool, () => ({ content: [{ type: "text", text: "legacy mon" }] }));
    const asked: Record<string, unknown>[] = [];
    const handle = withBaton(server, {
      dsn: DSN,
      settings: "console",
      resolvePrincipal: (context: { arguments?: Record<string, unknown> }) => {
        asked.push({ ...context.arguments });
        return null;
      },
    });
    try {
      await vi.waitFor(() => expect(collector.reads).toBeGreaterThan(0));
      await new Promise((resolve) => setImmediate(resolve));
      const client = await major.connect(server, { clientName });
      if (schema !== undefined) await client.listTools();
      asked.length = 0;
      await call(client, "legacy_book", args);
      await client.close();
    } finally {
      await handle.flush();
      await handle.aclose();
    }
    return { events: collector.events, asked };
  }

  it("a low-level Server's hook never sees user_goal on a tool it has not listed", async () => {
    const { events, asked } = await lowLevelCall("claude-code", undefined, { day: "mon", user_goal: GOAL });
    expect(asked).toEqual([{ day: "mon" }]);
    const start = events.find((e) => e.event_type === "tool_call_start");
    expect(start!.payload.call_intent).toBe(GOAL);
  });

  it("a low-level Server asks the hook once for a tool hidden from others but not this caller", async () => {
    const schema = { type: "object", properties: { day: { type: "string" } } };
    const { events, asked } = await lowLevelCall("cursor", schema, { day: "mon", user_goal: GOAL });
    expect(asked).toEqual([{ day: "mon" }]);
    const end = events.find((e) => e.event_type === "tool_call_end");
    expect(end!.capture.audience).toBe("everyone");
  });

  it("a low-level Server's hidden tool with its own user_goal keeps the other params", async () => {
    const schema = { type: "object", properties: { day: { type: "string" }, user_goal: { type: "string" } } };
    const { events } = await lowLevelCall("claude-code", schema, { day: "mon", user_goal: "own", expected_result: "x" });
    const start = events.find((e) => e.event_type === "tool_call_start");
    expect(start!.payload.params).toEqual({ day: "mon", user_goal: "own", expected_result: "x" });
  });
});

describe("reading overlays", () => {
  it("reads the Console's sample whole", () => {
    const document = parseDocument(JSON.stringify(SAMPLE))!;
    const beta = document.settingsFor({ labels: [], clientName: "claude-code", shareKey: null }, "srv");
    expect(beta.capture.overlay).toBe("ov_beta_1");
    expect(beta.overlay!.actions).toHaveLength(10);
    expect(beta.overlay!.hiddenTools).toEqual(new Set(["legacy_book"]));
    expect(document.serverOverlay!.actions).toHaveLength(3);
    const everyone = document.settingsFor({ labels: [], clientName: "cursor", shareKey: null }, "srv");
    expect(everyone.overlay).toBeUndefined();
  });

  it.each([{}, null, "not an object"])("an unknown overlay leaves the document valid: %j", (overlays) => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const document = parseDocument(JSON.stringify({ ...sample(), overlays }))!;
    const beta = document.settingsFor({ labels: [], clientName: "claude-code", shareKey: null }, "srv");
    expect(beta.overlay).toBeUndefined();
    expect(beta.capture).not.toHaveProperty("overlay");
    expect(document.serverOverlay).toBeUndefined();
  });

  it("an append starts a new paragraph after trailing space", () => {
    const append = { index: 0, change: "append", text: "Added." };
    expect(changedText("Line one.\n- item\n", [append])).toEqual({ text: "Line one.\n- item\n\nAdded.", source: "appended" });
    expect(changedText(undefined, [append])).toEqual({ text: "Added.", source: "appended" });
    const replace = { index: 1, change: "replace", text: "New." };
    expect(changedText("Old.", [replace, append])).toEqual({ text: "New.\n\nAdded.", source: "replaced" });
  });

  it("the refusal text takes the overlay", () => {
    const document = parseDocument(JSON.stringify(SAMPLE))!;
    const { overlay } = document.settingsFor({ labels: [], clientName: "claude-code", shareKey: null }, "srv");
    expect(buildRefusalText({ annotationToolName: "a", overlay })).toBe("Reports are off for now.");
  });

  it("a tool whose schema lost its params still has its hidden tools hidden", () => {
    const document = parseDocument(JSON.stringify(SAMPLE))!;
    const surface = new PerCallerSurface({
      settings: new CaptureSettings("srv", {
        document,
        start() {},
        stop() {},
        fetchCandidate: async () => ({ outcome: "failed" }),
      }),
      intentParamMode: "required",
      annotationToolName: "",
      pointer: () => undefined,
      writeInstructions: () => {},
      subagentLine: () => true,
      injectsGoal: () => true,
    });
    const settings = document.settingsFor({ labels: [], clientName: "claude-code", shareKey: null }, "srv");
    const served = surface.toolsFor(
      { tools: [{ name: "book_slot", inputSchema: { type: "object" } }, { name: "legacy_book", inputSchema: {} }] },
      { principal: null, organization: null, labels: [], settings },
    ) as { tools: { name: string }[] };
    expect(served.tools.map((tool) => tool.name)).toEqual(["book_slot"]);
  });

  it("a surface sent under another server overlay is sent again", () => {
    const sent = new SentSurfaces();
    sent.mark("d1", "ov_a");
    sent.mark("d2", "ov_b");
    expect(sent.wasSent("d1", "ov_a")).toBe(false);
    sent.mark("d1", "ov_a");
    expect(sent.wasSent("d1", "ov_a")).toBe(true);
    expect(sent.wasSent("d2", "ov_a")).toBe(false);
  });
});
