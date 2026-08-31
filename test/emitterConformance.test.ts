/**
 * Phase 3 — cross-SDK EMITTER conformance.
 *
 * `conformance.test.ts` (Phase 1) checks that this repo's Zod *schemas*
 * accept `baton-spec`'s vectors. That never runs `withBaton`, so it can't
 * catch the whole class of bugs Phase 3 exists for: the emitter populating
 * a field Python leaves null, omitting one Python always sends, starting
 * `sequence_number` at 0, ordering events differently, or nesting a payload
 * one level off. All of that is emitter behavior, and all of it was
 * untested until this file.
 *
 * This test drives a REAL tool call through `withBaton` into a capturing
 * sink, then diffs each emitted event against the corresponding
 * `baton-spec/vectors/*.json`.
 *
 * **Why no Python subprocess** (the design note's original Phase 3 shape):
 * `baton-spec/scripts/generate.py` builds the vectors by driving this exact
 * scenario through the Python SDK's mcp adapter and reading back FileSink's
 * JSONL — they are real Python-emitted envelopes, not hand-authored
 * examples. The vectors therefore ARE the cross-SDK reference, and shelling
 * to Python from a standalone TS repo's CI would add a Python toolchain, a
 * baton checkout, and a silently-wrong-build failure mode (cf. the 08-10 A5
 * incident) to re-derive bytes already committed here. When the Python SDK
 * changes its wire output, `generate.py` is re-run and the updated vectors
 * land here through the submodule bump — which is what should fail this
 * test.
 *
 * The scenario below MIRRORS `generate.py`'s: same vendor id, consent
 * token, tool names, arguments, and call order. Keep them in sync — if that
 * script's scenario changes, change this one.
 *
 * **Known coverage gap (verified by mutation, 2026-08-11):** `generate.py`
 * never calls a tool carrying `user_goal`/`expected_result`, so every
 * vector has `call_intent: null` / `intent_source: null` and no
 * param-sourced proactive annotation. Deleting the emitter's `intent_source`
 * assignment therefore does NOT fail this file — the Python reference run
 * doesn't exercise that path either, so there's nothing to diff against.
 * Cross-SDK agreement on the intent fields is currently asserted only
 * locally (withBaton.test.ts's intent-param suite, which does catch that
 * mutation). Closing it properly means adding an intent-carrying call to
 * `generate.py` and regenerating the vectors — a baton-spec change that
 * ripples to all four producer repos, so it's tracked in the sdk-hardening
 * thread rather than done here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { beforeAll, describe, expect, it } from "vitest";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import type { Event } from "../src/events.js";
import type { Sink } from "../src/sinks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsDir = path.join(here, "..", "baton-spec", "vectors");

function vector(eventType: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(vectorsDir, `${eventType}.json`), "utf-8")) as Record<
    string,
    unknown
  >;
}

/**
 * Envelope fields allowed to differ from the Python vector, each for a
 * reason that is NOT a wire divergence. Anything not listed here must match
 * exactly — that's the point of the test.
 */
const ENVELOPE_ALLOWED_TO_DIFFER = new Set([
  "event_id", // per-event UUID v7
  "session_id", // per-install fallback UUID
  "captured_at", // wall clock
  "sdk_version", // "ts-0.1.0" vs Python's "0.5.0" — deliberate, see version.ts
]);

/**
 * Payload fields allowed to differ, per event type. Everything else in the
 * payload must be deep-equal to the Python vector.
 */
const PAYLOAD_ALLOWED_TO_DIFFER: Record<string, ReadonlySet<string>> = {
  annotation: new Set<string>(),
  tool_call_start: new Set<string>(),
  tool_call_end: new Set([
    // The MCP handler contract differs by language: FastMCP returns the
    // serialized content list, the TS McpServer returns the `{content: [...]}`
    // object the callback itself produced. Both are "whatever the vendor
    // handler returned", which is what `result` is defined as — the shape
    // below is asserted separately rather than pinned to Python's.
    "result",
    "duration_ms", // timing
  ]),
  tool_call_error: new Set([
    // Error class names are language-specific: Python raises ValueError,
    // JS has no equivalent built-in. Asserted as a non-empty string below.
    "error_type",
    "duration_ms", // timing
  ]),
  surface_snapshot: new Set([
    // The vendor-true surface is genuinely different between the two
    // runtimes: FastMCP derives JSON Schema from Python type hints
    // (`lookupArguments` titles and all), the TS SDK from Zod. The hash is
    // over that content, and server_info carries each SDK's own version.
    // `seam_augmentations` — Baton's own contribution to the surface, the
    // part this SDK actually authors — is NOT exempt and must match.
    "surface_hash",
    "server_info",
    "capabilities",
    "tools",
  ]),
};

class CapturingSink implements Sink {
  readonly events: Event[] = [];
  async write(event: Event): Promise<void> {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async aclose(): Promise<void> {}
}

/** Mirrors `baton-spec/scripts/generate.py::_capture_events`. */
async function runSpecScenario(): Promise<Event[]> {
  const sink = new CapturingSink();
  const server = new McpServer({ name: "spec-vector-generator", version: "1.0.0" });

  server.registerTool("lookup", { inputSchema: { name: z.string() } }, (args: { name: string }) => ({
    content: [
      { type: "text" as const, text: JSON.stringify({ found: true, name: args.name }, null, 2) },
    ],
  }));
  server.registerTool("boom", {}, () => {
    throw new Error("simulated failure");
  });

  withBaton(server, {
    vendorId: "spec-vectors",
    vendorDisplayName: "Spec Vector Generator",
    consentToken: "ct_spec_vectors",
    sink,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "spec-scenario", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "spec-vectors_annotate",
    arguments: { user_goal: "look something up", expected_result: "a match" },
  });
  await client.callTool({ name: "lookup", arguments: { name: "alice" } });
  await client.callTool({ name: "boom", arguments: {} });

  return sink.events;
}

describe("cross-SDK emitter conformance (Phase 3)", () => {
  let events: Event[];

  beforeAll(async () => {
    events = await runSpecScenario();
  });

  it("emits the same event types, in the same order, as the Python reference run", () => {
    // generate.py's run produced exactly this sequence: the annotate call
    // emits `annotation`; the first wrapped tool call lazily flushes
    // `surface_snapshot` before its own start/end; the failing call emits
    // start/error. A difference here means the two SDKs disagree about
    // WHEN they capture, not just what.
    expect(events.map((e) => e.event_type)).toEqual([
      "annotation",
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
      "tool_call_start",
      "tool_call_error",
    ]);
  });

  it("assigns the same sequence numbers as the Python reference run", () => {
    // 1-based and monotonic per session, shared across event types — the
    // vectors carry 1,2,3,4,(5),6. An off-by-one start would let the
    // Console mis-order a TS-sourced session against a Python-sourced one.
    expect(events.map((e) => e.sequence_number)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const eventType of ["annotation", "surface_snapshot", "tool_call_start", "tool_call_end"]) {
      const emitted = events.find((e) => e.event_type === eventType)!;
      expect(emitted.sequence_number).toBe(vector(eventType).sequence_number);
    }
  });

  it.each([
    "annotation",
    "surface_snapshot",
    "tool_call_start",
    "tool_call_end",
    "tool_call_error",
  ])("%s: envelope matches the Python vector field-for-field", (eventType) => {
    const emitted = JSON.parse(
      JSON.stringify(events.find((e) => e.event_type === eventType)!),
    ) as Record<string, unknown>;
    const reference = vector(eventType);

    // Key set first — a missing or extra envelope field is the failure this
    // test most needs to catch, and comparing values alone would miss an
    // extra one entirely.
    expect(Object.keys(emitted).sort()).toEqual(Object.keys(reference).sort());

    for (const key of Object.keys(reference)) {
      if (key === "payload" || ENVELOPE_ALLOWED_TO_DIFFER.has(key)) continue;
      expect(emitted[key], `envelope field ${key}`).toEqual(reference[key]);
    }
  });

  it.each([
    "annotation",
    "surface_snapshot",
    "tool_call_start",
    "tool_call_end",
    "tool_call_error",
  ])("%s: payload matches the Python vector field-for-field", (eventType) => {
    const emitted = JSON.parse(
      JSON.stringify(events.find((e) => e.event_type === eventType)!),
    ) as Record<string, unknown>;
    const emittedPayload = emitted.payload as Record<string, unknown>;
    const referencePayload = vector(eventType).payload as Record<string, unknown>;
    const exempt = PAYLOAD_ALLOWED_TO_DIFFER[eventType]!;

    expect(Object.keys(emittedPayload).sort()).toEqual(Object.keys(referencePayload).sort());

    for (const key of Object.keys(referencePayload)) {
      if (exempt.has(key)) continue;
      expect(emittedPayload[key], `${eventType}.payload.${key}`).toEqual(referencePayload[key]);
    }
  });

  it("populates the exempt payload fields with the right shape, not just any value", () => {
    // The exemptions above are the only place a real divergence could hide,
    // so each one still gets a shape assertion.
    const end = events.find((e) => e.event_type === "tool_call_end")!;
    const error = events.find((e) => e.event_type === "tool_call_error")!;
    const snapshot = events.find((e) => e.event_type === "surface_snapshot")!;

    if (end.event_type === "tool_call_end") {
      expect(end.payload.result).not.toBeNull();
      expect(typeof end.payload.duration_ms).toBe("number");
      expect(end.payload.duration_ms).toBeGreaterThanOrEqual(0);
    }
    if (error.event_type === "tool_call_error") {
      expect(typeof error.payload.error_type).toBe("string");
      expect(error.payload.error_type.length).toBeGreaterThan(0);
      expect(typeof error.payload.duration_ms).toBe("number");
    }
    if (snapshot.event_type === "surface_snapshot") {
      expect(snapshot.payload.surface_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(snapshot.payload.server_info).toMatchObject({ name: "spec-vector-generator" });
      // The vendor-true surface excludes Baton's own injected annotate tool
      // and carries the vendor's two tools — same as the Python vector's.
      const tools = snapshot.payload.tools as Array<{ name: string }>;
      expect(tools.map((t) => t.name)).toEqual(["boom", "lookup"]);
    }
  });

  it("stamps a TS-prefixed sdk_version on every event", () => {
    // The one envelope field that MUST differ from Python — the Console
    // uses it to attribute a session to the TS SDK. A test that only
    // allowed it to differ wouldn't catch it silently becoming Python's.
    for (const event of events) {
      expect(event.sdk_version).toMatch(/^ts-/);
    }
    expect(vector("tool_call_start").sdk_version).not.toMatch(/^ts-/);
  });
});
