/**
 * SPEC §11.2 — fail open at the capture boundary, for the VENDOR'S SCRUBBER.
 *
 * `safeWrite` guards `sink.write` and `emit` guards payload construction, so the
 * scrubber calls inside a build thunk were already covered. The ones that run as
 * plain statements before the vendor's handler were not: a throw there escaped
 * both guards and returned `isError: true` to the agent for a tool call that
 * worked. Proven by running, on both majors, before the guard existed.
 *
 * ⚠ Each throwing leg is paired with a CONTROL on the same fixture under
 * `identityScrub`. Without it a leg passes vacuously whenever the fixture breaks
 * for an unrelated reason — and "the tool returned its real answer" is exactly
 * the assertion a broken fixture satisfies by never running the tool.
 *
 * ⚠ The legs are not interchangeable, and that is the point rather than
 * thoroughness. A test covering only runtime detection would leave every
 * in-handler site unguarded and still pass, because detection is reached from a
 * different module. They differ on HOW the scrubber is reached: through the
 * runtime ladder, through `_meta` on the tool path, through a goal param whose
 * key `extractGoalParam` has already stripped from `params` in place, and
 * through `_meta` again on Baton's own annotate tool.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { identityScrub } from "../../../src/scrub.js";
import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import { MAJORS, CapturingSink, terminal } from "./_majors.js";

const CFG = { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct" };
const ANSWER = "the-vendors-real-answer";
const GOAL = "find the row";

/** The name `_majors.connect` gives its client, which runtime detection scrubs on
 * every call. A literal, not read off the harness: reading it there would make
 * this leg pass if the harness stopped sending a name at all. */
const CLIENT_NAME = "test-client";

/** `_meta` reaches the scrubber as a fresh OBJECT built by
 * `roundMetaCoordinates`, so no string sentinel can fire there — the first
 * version of this file had a `_meta` leg that could not fail, and reverting that
 * guard left the whole suite green. Found by review. Keying on a marker INSIDE
 * the object reaches `_meta` without also detonating on `params`. */
const META_MARKER = "batonFailOpenMarker";

/** Throws only on the value its leg hands it, identity otherwise.
 *
 * ⚠ A scrubber that throws on EVERYTHING is a weaker test, measurably: it also
 * throws inside the `emit()` thunks, which drop both tool events by design — so
 * the only surviving assertion is "the call worked" and the sites become
 * indistinguishable. Throwing on one value keeps the events, which lets each leg
 * assert that ITS OWN field degraded. */
const throwingOn =
  (sentinel: string) =>
  (value: unknown): unknown => {
    if (value === sentinel) throw new Error(`vendor-scrubber-exploded on ${sentinel}`);
    return value;
  };

const throwingOnMeta = (value: unknown): unknown => {
  if (typeof value === "object" && value !== null && META_MARKER in value) {
    throw new Error("vendor-scrubber-exploded on _meta");
  }
  return value;
};

type Result = { isError?: unknown; content?: unknown };

/** The file's central claim, named once: the vendor's call lived and returned
 * the vendor's own answer. Each leg then reads as just "and ITS field degraded". */
function expectAnswered(res: Result): void {
  expect(res.isError).toBeFalsy();
  expect(JSON.stringify(res.content)).toContain(ANSWER);
}

/** The guard turned one failure mode into another, and the door is where that is
 * paid back: before `scrubOrNull`, a non-function `scrubber` threw on the first
 * tool call; after it, the TypeError is caught and every scrubbed field degrades
 * to `null` for the life of the process. Install-time refusal keeps it loud.
 * Major-independent, so it sits outside the matrix. */
it("a non-function scrubber is refused at INSTALL, not swallowed per call", () => {
  expect(() =>
    withBaton({} as never, { ...CFG, scrubber: "not-a-function" as unknown as (v: unknown) => unknown }),
  ).toThrow(/scrubber must be a function/);
});

describe.each(MAJORS)("a throwing vendor scrubber never breaks the call [$label]", (major) => {
  async function build(scrubber: (value: unknown) => unknown) {
    const sink = new CapturingSink();
    const server = major.make();
    const handle = withBaton(server, { ...CFG, sink, scrubber });
    major.tool(server, "lookup", { name: z.string() }, () => ({
      content: [{ type: "text", text: ANSWER }],
    }));
    const client = await major.connect(server);
    return { client, sink, annotateTool: handle.annotationToolName };
  }

  /** The vendor's own tool. */
  async function drive(
    scrubber: (value: unknown) => unknown,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<{ res: Result; sink: CapturingSink }> {
    const { client, sink } = await build(scrubber);
    const req: Record<string, unknown> = { name: "lookup", arguments: args };
    if (meta) req._meta = meta;
    return { res: (await client.callTool(req)) as Result, sink };
  }

  /** Baton's OWN annotate tool — a sibling of `drive`, because the blast radius
   * differs: here it is our tool failing and the agent retrying its friction
   * report, not the vendor's tool failing. */
  async function annotate(
    scrubber: (value: unknown) => unknown,
  ): Promise<{ res: Result; sink: CapturingSink }> {
    const { client, sink, annotateTool } = await build(scrubber);
    const res = (await client.callTool({
      name: annotateTool,
      arguments: { user_goal: "report the friction", signal_type: "dead_end" },
      _meta: { [META_MARKER]: "1" },
    })) as Result;
    return { res, sink };
  }

  const startOf = (sink: CapturingSink) =>
    sink.events.find((e) => e.event_type === "tool_call_start")!;

  it("CONTROL — identity scrubber: the tool answers, and we record the call", async () => {
    const { res, sink } = await drive(identityScrub, { name: "x" });
    expectAnswered(res);
    expect(terminal(sink, "tool_call_end").payload.tool_name).toBe("lookup");
  });

  it("runtime-detection leg — fires on EVERY call, and the TIER degrades", async () => {
    const { res, sink } = await drive(throwingOn(CLIENT_NAME), { name: "x" });
    expectAnswered(res);
    // The event survives and the field degrades — as opposed to dropping either.
    expect(terminal(sink, "tool_call_end").payload.tool_name).toBe("lookup");
    expect(terminal(sink, "tool_call_end").agent_runtime).toBe("unknown");
  });

  it("goal-param leg — the key is already stripped from params, so no throw may escape", async () => {
    const { res, sink } = await drive(throwingOn(GOAL), { name: "x", user_goal: GOAL });
    expectAnswered(res);
    // The intent is lost, not fabricated and not half-applied.
    expect(startOf(sink).payload).toMatchObject({ call_intent: null });
  });

  it("CONTROL for the goal-param leg — identity scrubber captures the intent", async () => {
    const { res, sink } = await drive(identityScrub, { name: "x", user_goal: GOAL });
    expectAnswered(res);
    expect(startOf(sink).payload).toMatchObject({ call_intent: GOAL });
  });

  it("_meta leg — the object the client sent, and `runtime_meta` degrades", async () => {
    const { res, sink } = await drive(throwingOnMeta, { name: "x" }, { [META_MARKER]: "1" });
    expectAnswered(res);
    expect(startOf(sink).runtime_meta).toBeNull();
  });

  it("CONTROL for the _meta leg — identity scrubber carries the meta through", async () => {
    const { res, sink } = await drive(identityScrub, { name: "x" }, { [META_MARKER]: "1" });
    expectAnswered(res);
    expect(startOf(sink).runtime_meta).toMatchObject({ [META_MARKER]: "1" });
  });

  it("ANNOTATION handler has the same `_meta` statement, and it is guarded too", async () => {
    const { res, sink } = await annotate(throwingOnMeta);
    expect(res.isError).toBeFalsy();
    // ⚠ The event must SURVIVE, not merely the call. `isError` falsy alone is
    // also satisfied when the annotation event is DROPPED — so moving this scrub
    // back inside the `emit()` thunk would keep that assertion green while losing
    // the annotation. The tool-path leg already asserts its event survives; this
    // one did not, and its own control did the stronger check. Found by review.
    const annotation = sink.events.find((e) => e.event_type === "annotation")!;
    expect(annotation.runtime_meta).toBeNull();
  });

  it("CONTROL for the annotation leg — identity scrubber, same call", async () => {
    const { res, sink } = await annotate(identityScrub);
    expect(res.isError).toBeFalsy();
    expect(sink.events.some((e) => e.event_type === "annotation")).toBe(true);
  });
});
