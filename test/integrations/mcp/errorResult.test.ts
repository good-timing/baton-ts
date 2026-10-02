/**
 * SPEC §11.4.3 — the second failure shape: the vendor handler returns
 * normally and the result carries MCP's error flag, which MCP files as a 200
 * rather than a JSON-RPC error. Until the change this file covers, this
 * package classified on thrown exceptions alone and filed every such failure
 * as `tool_call_end` — a success.
 *
 * Measured first, on both majors (2026-09-24): what the wrapper receives is
 * the vendor's LITERAL return, camelCase `isError`, unconverted by either
 * SDK. That is why `errorResult.ts` reads one spelling and why it does not
 * carry Python's `content`-must-be-a-list guard — see its own notes.
 *
 * ⚠ Every assertion here pins `event_type` BEFORE reading a body. Taken off
 * "whichever terminal event was emitted", the body assertions pass against
 * the OLD behaviour too: the flag was already inside `tool_call_end.result`.
 * That is the Python change's recorded lesson, and it applies verbatim here.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ERROR_BODY_MAX_CODE_POINTS,
  errorText,
  isErrorResult,
} from "../../../src/integrations/mcp/errorResult.js";
import { MAJORS, CapturingSink, install, terminal } from "./_majors.js";

describe.each(MAJORS)("returned isError — $label", (major) => {
  it("files a RETURNED error flag as tool_call_error, not tool_call_end", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "soft_fail", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "You do not have access to that Project" }],
      isError: true,
    }));
    install(server, sink);
    const client = await major.connect(server);
    const wire = (await client.callTool({
      name: "soft_fail",
      arguments: { name: "p1" },
    })) as { isError?: boolean; content: { text: string }[] };

    const event = terminal(sink, "tool_call_error");
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_error",
    ]);
    expect(event.payload.tool_name).toBe("soft_fail");
    // The registered literal, not a constructor name — same value Python and
    // `baton-extmcp` use, which is what makes the three sensors comparable.
    expect(event.payload.error_type).toBe("tool_error");
    // The reason, unwrapped from the content text parts.
    expect(event.payload.error_body).toBe("You do not have access to that Project");
    // The ENVELOPE, not the unwrapped developer return: the flag lives there.
    expect(event.payload.result).toEqual({
      content: [{ type: "text", text: "You do not have access to that Project" }],
      isError: true,
    });
    expect(typeof event.payload.duration_ms).toBe("number");

    // §11.2 — the caller's result is untouched. Reclassifying must not turn a
    // returned failure into a thrown one.
    expect(wire.isError).toBe(true);
    expect(wire.content[0]!.text).toBe("You do not have access to that Project");
  });

  it("leaves a successful call alone, isError: false included", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "ok", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "fine" }],
      // The explicit-false case is the one a `"isError" in result` check
      // would get wrong, and it is what a vendor writes when it branches.
      isError: false,
    }));
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "ok", arguments: { name: "p1" } });

    const event = terminal(sink, "tool_call_end");
    expect(event.payload.result).toEqual({
      content: [{ type: "text", text: "fine" }],
      isError: false,
    });
  });

  it("does not read a flag nested in the vendor's own structuredContent", async () => {
    // The negative control. `{isError: true}` INSIDE `structuredContent` is
    // the vendor's domain data — the SDK never marks the call failed for it,
    // and neither may we. Measured: the wire result has no top-level flag.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "domain", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { isError: true, rows: 0 },
    }));
    install(server, sink);
    const client = await major.connect(server);
    const wire = (await client.callTool({
      name: "domain",
      arguments: { name: "p1" },
    })) as { isError?: boolean };

    expect(wire.isError).toBeFalsy();
    terminal(sink, "tool_call_end");
  });

  it("agrees with the client on a flagged result that carries no content at all", async () => {
    // ⚠ This is the cell that decides the `content` guard, and it is why this
    // package deviates from Python's helper. Measured on both majors: a tool
    // returning `{isError: true, rows: 0}` reaches the CLIENT as
    // `{content: [], isError: true}` — a failure, by the caller's reckoning.
    // A `content`-must-be-a-list guard would file it as a success.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "odd", { name: z.string() }, () => ({ isError: true, rows: 0 }));
    install(server, sink);
    const client = await major.connect(server);
    const wire = (await client.callTool({
      name: "odd",
      arguments: { name: "p1" },
    })) as { isError?: boolean };

    expect(wire.isError).toBe(true);
    const event = terminal(sink, "tool_call_error");
    // No content, so no reason. "" says "no reason given", which the Console
    // already renders as such — not `[object Object]`.
    expect(event.payload.error_body).toBe("");
    expect(event.payload.result).toEqual({ isError: true, rows: 0 });
  });

  it("files a failure the SDK manufactures above the handler, naming the kind", async () => {
    // ⚠ **This test used to assert the OPPOSITE**, as the limit it was written
    // to pin: `isErrorResult` sits at the executor and output-schema validation
    // runs above it, so the sensor correctly saw a success and filed
    // `tool_call_end` for a call the client saw fail. Its own note said "if it
    // starts failing because `tool_call_error` is emitted, the gap closed and
    // this should become the positive assertion." The `tools/call` seam closed
    // it; this is that assertion.
    //
    // ⚠ **And flipping it corrected a measurement.** `iserror_sensor_probe.md`
    // recorded this false success as 2.x-ONLY, from a 10-01 probe where the
    // 1.x leg produced no caller-visible failure (and whose note said why was
    // unmeasured). It fires on BOTH here — the two `expect`s below were in the
    // old version of this test and have been green in CI throughout — so
    // `@modelcontextprotocol/sdk` 1.x validates output too and the gap was
    // never one major's. That makes this seam worth more than the note claims,
    // not less.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(
      server,
      "validated",
      { name: z.string() },
      () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      // The output schema the handler does not satisfy: it returns `content`
      // and no `structuredContent`.
      { rows: z.number() },
    );
    install(server, sink);
    const client = await major.connect(server);
    const wire = (await client.callTool({
      name: "validated",
      arguments: { name: "p1" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(wire.isError).toBe(true);
    expect(wire.content[0]!.text).toContain("Output validation error");
    const event = terminal(sink, "tool_call_error");
    // ONE terminal event on the call, not two: the inner wrapper parked its
    // `tool_call_end` and the outer replaced it, rather than both emitting —
    // which would put two terminals on one `call_id` and break SPEC §11.5.4's
    // tier-1 pairing on every call of this kind.
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_error",
    ]);
    expect(event.payload.failure_kind).toBe("output_schema_mismatch");
    // The handler RETURNED and our conversion rejected what came back, so the
    // reason is result-derived and the reason text is the SDK's own.
    expect(event.payload.error_body).toContain("Output validation error");
    expect(event.payload.error_type).toBe("tool_error");
    // ⚠ The sequence numbers have no HOLE in them, which is the assertion
    // that pins `terminate` parking a BUILDER rather than a built event. The
    // replaced `tool_call_end` was never constructed, so it never called
    // `counter.next` — had it, this session's numbering would read 1, 2, 4
    // and no consumer could tell that from a dropped event.
    expect(sink.events.map((e) => e.sequence_number)).toEqual([1, 2, 3]);
  });

  it("cuts `error_body` by code point, never through a surrogate pair", async () => {
    // Why the cut is `capCodePoints` and not `.slice()`: a boundary landing
    // inside a surrogate pair ships a LONE SURROGATE, which survives
    // `JSON.stringify` and then raises `UnicodeEncodeError` in the first
    // Python consumer that re-encodes it. `src/_text.ts` carries the full
    // reasoning; this is the first failure-path value to inherit it.
    const reason = "x".repeat(ERROR_BODY_MAX_CODE_POINTS - 1) + "\u{1F600}" + "tail";
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "wide", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: reason }],
      isError: true,
    }));
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "wide", arguments: { name: "p1" } });

    const event = terminal(sink, "tool_call_error");
    expect([...event.payload.error_body]).toHaveLength(ERROR_BODY_MAX_CODE_POINTS);
    // The emoji survived whole rather than being halved.
    expect(event.payload.error_body.endsWith("\u{1F600}")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(event.payload.error_body)).toBe(false);
  });

  it("still files a THROW under its constructor name, with a null result", async () => {
    // The shape that already worked. It must keep working, and it must keep
    // saying `result: null` — Python's throw vector carries the key.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "boom", { name: z.string() }, () => {
      throw new TypeError("simulated failure");
    });
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "boom", arguments: { name: "p1" } });

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.error_type).toBe("TypeError");
    expect(event.payload.error_body).toBe("simulated failure");
    expect(event.payload.result).toBeNull();
    expect(Object.keys(event.payload)).toContain("result");
  });

  it("scrubs the reason and the envelope at all", async () => {
    // The control for the straddle case below, which can only assert that a
    // fragment is ABSENT — and absence is also what truncating the whole
    // thing away would produce. This one is short enough that nothing is cut,
    // so it says the scrubber is wired into this leg in the first place.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "leaky", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "no account for alice@example.com" }],
      isError: true,
    }));
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "leaky", arguments: { name: "p1" } });

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.error_body).toBe("no account for [REDACTED:email]");
    // The envelope is scrubbed too, and it is NOT truncated.
    expect(JSON.stringify(event.payload.result)).not.toContain("alice@example.com");
    expect(JSON.stringify(event.payload.result)).toContain("[REDACTED:email]");
  });

  it("scrubs the reason BEFORE truncating it", async () => {
    // The PII bug `/code-review` found in the Python change, pinned here so
    // it cannot be ported in later. The address is positioned to STRADDLE the
    // 2000-char boundary: cut first and the scrubber is handed `alice@exam`,
    // which has no TLD and matches no pattern, so the surviving half ships
    // unredacted. Scrub first and there is no address left to straddle.
    //
    // The assertion is the fragment's ABSENCE, not a redaction token's
    // presence: scrubbing first shortens the string enough that the cut lands
    // inside `[REDACTED:email]` itself. The test above is what rules out
    // "absent because everything was truncated away".
    const email = "alice@example.com";
    // Derived from the cap, not hardcoded beside it: a bump to the constant
    // would otherwise move the boundary out from under the address and leave
    // this asserting nothing.
    const reason = `${"x".repeat(ERROR_BODY_MAX_CODE_POINTS - 11)} ${email} trailing`;
    const survivesACutFirst = [...reason].slice(0, ERROR_BODY_MAX_CODE_POINTS).join("");
    expect(survivesACutFirst.endsWith("alice@exam")).toBe(true);

    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "leaky", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: reason }],
      isError: true,
    }));
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "leaky", arguments: { name: "p1" } });

    const event = terminal(sink, "tool_call_error");
    // Code points, which is the unit the cap is in.
    expect([...event.payload.error_body].length).toBeLessThanOrEqual(
      ERROR_BODY_MAX_CODE_POINTS,
    );
    expect(event.payload.error_body).not.toContain("alice@exam");
    // And the envelope, which is never truncated, keeps nothing either.
    expect(JSON.stringify(event.payload.result)).not.toContain("alice@exam");
  });
});

describe("errorResult helpers", () => {
  it("isErrorResult is true only for a truthy top-level flag", () => {
    expect(isErrorResult({ content: [], isError: true })).toBe(true);
    expect(isErrorResult({ isError: true })).toBe(true);
    expect(isErrorResult({ content: [], isError: false })).toBe(false);
    expect(isErrorResult({ content: [] })).toBe(false);
    expect(isErrorResult({ structuredContent: { isError: true } })).toBe(false);
    expect(isErrorResult(null)).toBe(false);
    expect(isErrorResult(undefined)).toBe(false);
    expect(isErrorResult("isError")).toBe(false);
  });

  it("isErrorResult fails to false rather than throwing on the vendor's call path", () => {
    // SPEC §11.2: a sensor never blocks the call. A lazily-computed property
    // that throws must cost the classification, not the vendor's response.
    const hostile = {} as { isError?: boolean };
    Object.defineProperty(hostile, "isError", {
      get() {
        throw new Error("nope");
      },
    });
    expect(isErrorResult(hostile)).toBe(false);
  });

  it("errorText fails to empty rather than throwing on the vendor's call path", () => {
    // The sibling of `isErrorResult`'s guard, and reachable for the same
    // reason: `content` is a property read, and a property read is what
    // throws. SPEC §11.2 — a sensor never blocks the call.
    const hostile = {} as { content?: unknown };
    Object.defineProperty(hostile, "content", {
      get() {
        throw new Error("nope");
      },
    });
    expect(errorText(hostile)).toBe("");
  });

  it("errorText joins the text parts and says nothing when there are none", () => {
    expect(
      errorText({
        content: [
          { type: "text", text: " first " },
          { type: "image", data: "…" },
          { type: "text", text: "second" },
          { type: "text", text: "   " },
        ],
      }),
    ).toBe("first\nsecond");
    expect(errorText({ content: [] })).toBe("");
    expect(errorText({ isError: true })).toBe("");
    expect(errorText(null)).toBe("");
  });
});
