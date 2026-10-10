/**
 * SPEC §11.4.3 `failure_kind` — the failures the SDK manufactures ABOVE the
 * vendor's handler, which this package emitted NOTHING for until the
 * `tools/call` seam landed.
 *
 * Three of the four are request-side: an unknown tool, a disabled tool and a
 * rejected argument. The handler never runs, so the inner executor wrapper is
 * never entered and had no event to emit — the gap was a silence, not a
 * misfiling. (The fourth, `output_schema_mismatch`, IS a misfiling and lives
 * in `errorResult.test.ts` beside the predicate whose scope it tests.)
 *
 * ⚠ **Every case here is driven through a real client over a real transport**,
 * because that is the only way the outer seam runs at all. A test that
 * invoked the executor directly would exercise the no-store fallback and
 * prove the opposite of what it claims.
 *
 * ⚠ **The majors do NOT agree on the shape, and that is asserted rather than
 * abstracted away.** 1.x converts all three into a returned `isError` inside
 * its own `try` (`mcp.js:101-108`); v2 THROWS a `ProtocolError` for the first
 * two and returns the third (`mcp-DXXb3Vv3.mjs:1394-1399`). So `error_type`
 * legitimately differs per major for one customer-visible failure —
 * §11.4.3's RAISE/RETURN discriminator reporting the shape faithfully — and
 * `failure_kind` is what makes them comparable. That is the measurement that
 * justified putting the member on the wire.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FAILURE_KINDS,
  requestSideFailureKind,
} from "../../../src/integrations/mcp/errorResult.js";
import { MAJORS, CapturingSink, install, terminal } from "./_majors.js";

/** The registered vocabulary, pinned as literals.
 *
 * ⚠ This is the cheapest guard against the drift that has already cost this
 * release two defects: `invalid_argument` is SINGULAR and identical to
 * `baton-console`'s code of the same name, and pluralising it would pass
 * lint, typecheck and every behavioural test here — the Console's
 * `_FAILURE_KIND_TO_CODE` is an allow-list, so an unregistered value is
 * simply absent from it and falls through to prose classification. Nothing
 * else in this package can observe that, because the wire schema types the
 * member as an open string ON PURPOSE (SPEC §11.4.3). So the spelling is
 * pinned here, where a change to it fails BY NAME.
 */
describe("the registered failure_kind vocabulary", () => {
  it("is exactly SPEC §11.4.3's four values, spelled as the Console's codes are", () => {
    expect([...FAILURE_KINDS]).toEqual([
      "unknown_tool",
      "tool_disabled",
      "invalid_argument",
      "output_schema_mismatch",
    ]);
  });

  it("withdraws the claim rather than guessing, for the two task modes 1.x rejects early", () => {
    // 1.x rejects a tool declaring `taskSupport: "required"` or `"optional"`
    // with an ordinary function callback BEFORE it looks at any argument
    // (`mcp.js:112-116`), so "present and enabled" does not imply the
    // arguments were the problem there. SPEC permits omitting the member;
    // naming `invalid_argument` would tell the operator the agent sent bad
    // arguments when the remedy is the vendor's own registration.
    expect(requestSideFailureKind(undefined)).toBe("unknown_tool");
    expect(requestSideFailureKind(null)).toBe("unknown_tool");
    expect(requestSideFailureKind({ enabled: false })).toBe("tool_disabled");
    expect(requestSideFailureKind({ enabled: true })).toBe("invalid_argument");
    expect(requestSideFailureKind({ enabled: true, execution: {} })).toBe("invalid_argument");
    // ⚠ **`"forbidden"` must stay `invalid_argument`, and this is the
    // assertion that matters most here.** 1.x's `registerTool` sets exactly
    // this on EVERY ordinary tool it builds (`mcp.js:694,704`), so a
    // predicate asking "is `taskSupport` set" withdraws the claim for the
    // whole pinned peer — which is what the first version did, caught by the
    // 1.x leg of the `invalid_argument` case below.
    expect(requestSideFailureKind({ enabled: true, execution: { taskSupport: "forbidden" } })).toBe(
      "invalid_argument",
    );
    expect(
      requestSideFailureKind({ enabled: true, execution: { taskSupport: "required" } }),
    ).toBeUndefined();
    expect(
      requestSideFailureKind({ enabled: true, execution: { taskSupport: "optional" } }),
    ).toBeUndefined();
    // ⚠ A DISABLED task tool is still `tool_disabled`: the vendor switched it
    // off and that is why it did not run, regardless of what else it
    // declares. Order matters, so it is asserted.
    expect(
      requestSideFailureKind({ enabled: false, execution: { taskSupport: "required" } }),
    ).toBe("tool_disabled");
  });
});

describe.each(MAJORS)("failures above the handler — $label", (major) => {
  /** One registered, working tool plus a connected client — the baseline every
   * case below departs from in exactly one way. */
  const connected = async (sink: CapturingSink, outputShape?: Record<string, z.ZodType>) => {
    const server = major.make();
    major.tool(
      server,
      "works",
      { name: z.string() },
      () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      outputShape,
    );
    // ⚠ The handle's RESOLVED name, never a guessed `${vendorId}_annotate`:
    // the name is derived from the SERVER's own name first, so these fixtures
    // register `vendor_annotate`. Guessing it made the annotate-tool case
    // below call a tool that does not exist — which emitted a perfectly
    // correct `unknown_tool` and read as the exclusion failing.
    const handle = install(server, sink);
    return { server, handle, client: await major.connect(server) };
  };

  it("emits a start and an error for an UNKNOWN tool, where it used to emit nothing", async () => {
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    await client.callTool({ name: "no_such_tool", arguments: { name: "p1" } }).catch(() => {
      // v2 surfaces this as a rejected request rather than a flagged result;
      // what the CALLER got is asserted per major below, not here.
    });

    const event = terminal(sink, "tool_call_error");
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_error",
    ]);
    expect(event.payload.failure_kind).toBe("unknown_tool");
    expect(event.payload.tool_name).toBe("no_such_tool");
    expect(event.payload.error_body).toContain("no_such_tool");
    // The handler never ran, so there is no handler duration to report and no
    // result to record. `null` on both, and NO `result_capture` marker:
    // nothing on this payload is derived from a result.
    expect(event.payload.duration_ms).toBeNull();
    expect(event.payload.result).toBeNull();
    expect(JSON.parse(JSON.stringify(event.payload))).not.toHaveProperty("result_capture");
    // Tier 1 of SPEC §11.5.4 pairs the two legs on the id this seam minted.
    const start = sink.events[1]!;
    expect(start.event_type).toBe("tool_call_start");
    expect(event.call_id).toBe(start.call_id);
    expect(typeof event.call_id).toBe("string");
  });

  it("emits `tool_disabled` for a tool the vendor switched off", async () => {
    // ⚠ The case that JUSTIFIES the member, and it was not in the first
    // proposal. Both majors send the client "Tool <name> disabled", which
    // matches no lane in the Console's text vocabulary — so it classified
    // `unclassified` with the full message in hand, and no regex could have
    // rescued it. It is also not `unknown_tool`: the tool exists and the
    // vendor turned it off, so the remedy is theirs and nothing the agent
    // does helps.
    const sink = new CapturingSink();
    const { server, client } = await connected(sink);
    (server as { _registeredTools: Record<string, { disable(): void }> })._registeredTools[
      "works"
    ]!.disable();
    await client.callTool({ name: "works", arguments: { name: "p1" } }).catch(() => {});

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.failure_kind).toBe("tool_disabled");
    expect(event.payload.error_body).toContain("disabled");
    expect(event.payload.tool_name).toBe("works");
  });

  it("emits `invalid_argument` for a rejected argument, with the arguments on the start", async () => {
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    // `name` is declared `z.string()`; a number fails validation ABOVE the
    // executor on both majors.
    await client.callTool({ name: "works", arguments: { name: 7 } }).catch(() => {});

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.failure_kind).toBe("invalid_argument");
    // ⚠ The start event is what carries the ARGUMENTS, and they are the whole
    // diagnostic for this kind. `baton-console`'s pairer does build a row
    // from an orphan end, but with no start it has no `params` at all — so
    // emitting only the error would have made the commonest of these three
    // the least useful.
    const start = sink.events[1]!;
    expect(start.event_type).toBe("tool_call_start");
    expect(start.payload).toMatchObject({ tool_name: "works", params: { name: 7 } });
  });

  it("keeps `error_body` under `resultCaptureMode: \"off\"` — nothing here is result-derived", async () => {
    // ⚠ The asymmetry with `output_schema_mismatch`, which is WITHHELD under
    // the same mode. SPEC §11.4.3 keys the rule on PROVENANCE: a validator's
    // rejection describes the request and the producer's own decision, so it
    // stays (still scrubbed — it can echo argument values); an output-schema
    // message quotes what the tool RETURNED, so it goes.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "works", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    // ⚠ Through the shared helper's `extra`, not a forked literal. The whole
    // point of `install(server, sink, extra)` taking options is that a case
    // varying ONE of them does not re-spell the config — which is how this
    // very site drifted before.
    install(server, sink, { resultCaptureMode: "off" });
    const client = await major.connect(server);
    await client.callTool({ name: "works", arguments: { name: 7 } }).catch(() => {});

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.failure_kind).toBe("invalid_argument");
    expect(event.payload.error_body).not.toBe("");
    expect(JSON.parse(JSON.stringify(event.payload))).not.toHaveProperty("result_capture");
  });

  it("files a VENDOR raise as before — no `failure_kind`, and the class name kept", async () => {
    // The regression this seam could most easily have caused. Both majors
    // convert a thrown handler error into a returned `isError` INSIDE
    // `tools/call`, so the outer sees a flagged result on a call whose inner
    // DID fire. Replacing a parked failure would relabel the vendor's own
    // exception as our conversion's — which is why only the SUCCESS lane is
    // replaceable.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "boom", { name: z.string() }, () => {
      throw new TypeError("the vendor's own problem");
    });
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "boom", arguments: { name: "p1" } }).catch(() => {});

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.error_type).toBe("TypeError");
    expect(event.payload.error_body).toContain("the vendor's own problem");
    expect(JSON.parse(JSON.stringify(event.payload))).not.toHaveProperty("failure_kind");
  });

  it("files a RETURNED flag as before — no `failure_kind`, it is the vendor's prose", async () => {
    // SPEC §11.4.3's other note: the member covers only what the PRODUCER
    // manufactures. A tool returning "you do not have access" is the vendor
    // speaking and a consumer must keep classifying it from text.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "soft", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "You do not have access" }],
      isError: true,
    }));
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "soft", arguments: { name: "p1" } });

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.error_type).toBe("tool_error");
    expect(JSON.parse(JSON.stringify(event.payload))).not.toHaveProperty("failure_kind");
  });

  it("leaves the happy path byte-identical — one terminal event, in order", async () => {
    // The 98-test blast radius in one assertion: the outer seam runs on every
    // call now, and a success must come out of it exactly as it did before —
    // one `tool_call_end`, no duplicate, no reordering, no gap in the
    // sequence numbers from a parked event that allocated one.
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    const wire = (await client.callTool({ name: "works", arguments: { name: "p1" } })) as {
      isError?: boolean;
    };

    expect(wire.isError).toBeFalsy();
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_end",
    ]);
    expect(sink.events.map((e) => e.sequence_number)).toEqual([1, 2, 3]);
  });

  it("keeps BOTH terminals when one handler calls another tool in-process", async () => {
    // ⚠ **A regression the park introduced, caught by review and fixed.**
    // `CallSlot` holds ONE parked terminal, so a second wrapped executor
    // inside the same `tools/call` dispatch overwrote the first — leaving the
    // inner call's `tool_call_start` with no terminal at all, permanently
    // unpaired under SPEC §11.5.4. `terminate` now flushes an
    // already-parked terminal before storing its own.
    //
    // v2's legacy `inputRequired` shim reaches the same bug by a different
    // road (`mcp-DXXb3Vv3.mjs:602` loops `await handler(request, ctxNext)`
    // inside one dispatch), which is why the fix is in the park rather than a
    // guard against this one shape.
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "inner", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "inner" }],
    }));
    major.tool(server, "outer", { name: z.string() }, async () => {
      const entry = (
        server as { _registeredTools: Record<string, { handler?: unknown; executor?: unknown }> }
      )._registeredTools["inner"]!;
      const target = (typeof entry.executor === "function" ? entry.executor : entry.handler) as (
        ...a: unknown[]
      ) => unknown;
      await target({ name: "nested" }, {});
      return { content: [{ type: "text" as const, text: "outer" }] };
    });
    install(server, sink);
    const client = await major.connect(server);
    await client.callTool({ name: "outer", arguments: { name: "p1" } });

    // Two starts and TWO ends. The inner one is flushed unreplaced when the
    // outer parks, so it lands between the two starts' terminals.
    expect(sink.events.map((e) => e.event_type)).toEqual([
      "surface_snapshot",
      "tool_call_start",
      "tool_call_start",
      "tool_call_end",
      "tool_call_end",
    ]);
    // Every start has a terminal with its own `call_id` — the property the
    // event-type list alone does not prove.
    const starts = sink.events.filter((e) => e.event_type === "tool_call_start");
    const ends = sink.events.filter((e) => e.event_type === "tool_call_end");
    expect(starts.map((e) => e.call_id).sort()).toEqual(ends.map((e) => e.call_id).sort());
  });

  it("reports a PROTOTYPE-named tool as unknown, rather than saying nothing", async () => {
    // ⚠ `_registeredTools` is a plain object, so `registry["constructor"]`
    // answers `Object` — non-undefined, so the "a tool we did not wrap" guard
    // declined to report and a caller-visible `Tool constructor disabled`
    // reached the client with this seam silent. `Object.hasOwn` is what makes
    // the lookup answer the question it is asking.
    const sink = new CapturingSink();
    const { client } = await connected(sink);
    await client.callTool({ name: "constructor", arguments: { name: "p1" } }).catch(() => {});

    const event = terminal(sink, "tool_call_error");
    expect(event.payload.failure_kind).toBe("unknown_tool");
    expect(event.payload.tool_name).toBe("constructor");
  });

  it("says NOTHING about Baton's own annotate tool", async () => {
    // It is excluded from `wrapIfNeeded` because it emits `annotation`, not
    // `tool_call_*`. A rejected argument on it must not file an
    // `invalid_argument` about a tool the vendor does not own — and the
    // request-side path is the one place that exclusion has to be repeated,
    // since there is no inner wrapper to decline for it.
    const sink = new CapturingSink();
    const { client, handle } = await connected(sink);
    const before = sink.events.length;
    await client
      .callTool({ name: handle.annotationToolName, arguments: { what_happened: 42 } })
      .catch(() => {});

    expect(sink.events.slice(before).filter((e) => e.event_type !== "surface_snapshot")).toEqual(
      [],
    );
  });
});
