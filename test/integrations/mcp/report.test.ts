/**
 * The annotate tool takes reports only (SPEC §5.1.1): a call with no
 * `what_happened` is refused, `tool_name` is advertised as required and
 * never enforced, and both fields reach the wire scrubbed.
 */

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { isReport } from "../../../src/integrations/mcp/annotation.js";
import { CapturingSink, install, MAJORS } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const redactEmail = (value: unknown): unknown =>
  typeof value === "string" ? value.replace("jane@example.com", "[REDACTED]") : value;

/** Rewrites every string, so a value that comes out unchanged was never
 * handed to the scrubber. */
const redactAll = (value: unknown): unknown => (typeof value === "string" ? "[X]" : value);

describe("isReport", () => {
  it.each(["", "   ", "\n\t", null, undefined])("is false for %j", (blank) => {
    expect(isReport(blank)).toBe(false);
  });

  it("is true for an account with any text", () => {
    expect(isReport(" it failed ")).toBe(true);
  });
});

describe.each(MAJORS)("reports on $label", (major) => {
  async function connected(extra: Parameters<typeof install>[2] = {}) {
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "lookup", { name: z.string(), tool_name: z.string().optional() }, () => ({
      content: [{ type: "text" as const, text: "found" }],
    }));
    const handle = install(server, sink, extra);
    const client = await major.connect(server);
    const annotate = async (args: Record<string, unknown>): Promise<any> =>
      JSON.parse(
        (await client.callTool({ name: handle.annotationToolName, arguments: args })).content[0]
          .text,
      );
    return { sink, client, annotate, name: handle.annotationToolName };
  }

  const annotations = (sink: CapturingSink) =>
    sink.events.filter((e) => e.event_type === "annotation");

  it("emits one annotation, and no tool_call events for the annotate call", async () => {
    const { sink, annotate } = await connected();
    const answer = await annotate({
      user_goal: "look something up",
      what_happened: "asked for a match; got an error with no reason",
      tool_name: "lookup",
      suggested_improvement: "say why",
    });

    expect(answer).toEqual({ ok: true });
    expect(sink.events.map((e) => e.event_type)).toEqual(["annotation"]);
    expect(sink.events[0]!.payload).toEqual({
      intent: "look something up",
      expected_outcome: null,
      what_happened: "asked for a match; got an error with no reason",
      signal_type: null,
      workflow: null,
      suggested_improvement: "say why",
      context: null,
      intent_source: null,
      tool_name: "lookup",
    });
  });

  it.each([{}, { what_happened: "" }, { what_happened: "   " }])(
    "refuses a call that is not a report (%j) and emits nothing",
    async (account) => {
      const { sink, annotate, name } = await connected();
      const answer = await annotate({
        user_goal: "look something up",
        expected_result: "a match",
        ...account,
      });

      expect(answer).toEqual({
        ok: false,
        error:
          `${name} is reactive-only on this server. Call it only AFTER a tool call ` +
          "returns an unhelpful, empty, failed or contradictory result, or when no tool " +
          "covers what the user asked for — and say what_happened. What the user is trying " +
          "to do is already recorded on each tool call, so no pre-call annotation is needed.",
      });
      expect(sink.events).toEqual([]);
    },
  );

  it("a refused call uses no sequence number", async () => {
    const { sink, annotate } = await connected();
    await annotate({ user_goal: "look something up" });
    await annotate({ user_goal: "look something up", what_happened: "it failed" });
    expect(sink.events.map((e) => e.sequence_number)).toEqual([1]);
  });

  it.each([
    { sent: "lookup", onTheWire: "[X]" },
    { sent: "none", onTheWire: "[X]" },
    { sent: "", onTheWire: "" },
    { sent: undefined, onTheWire: null },
    { sent: null, onTheWire: null },
  ])("sends tool_name $sent as $onTheWire", async ({ sent, onTheWire }) => {
    const { sink, annotate } = await connected({ scrubber: redactAll });
    await annotate({
      user_goal: "look something up",
      what_happened: "it failed",
      ...(sent === undefined ? {} : { tool_name: sent }),
    });
    expect(annotations(sink)[0]!.payload.tool_name).toBe(onTheWire);
  });

  it("scrubs what_happened and tool_name", async () => {
    const { sink, annotate } = await connected({ scrubber: redactEmail });
    await annotate({
      user_goal: "look something up",
      what_happened: "asked for jane@example.com; got a 500",
      tool_name: "lookup jane@example.com",
    });
    expect(annotations(sink)[0]!.payload).toMatchObject({
      what_happened: "asked for [REDACTED]; got a 500",
      tool_name: "lookup [REDACTED]",
    });
  });

  it.each(["required", "optional", "off"] as const)(
    "lists tool_name as required and what_happened as not, under intentParamMode '%s'",
    async (intentParamMode) => {
      const { client, name } = await connected({ intentParamMode });
      const { tools } = await client.listTools();
      const schema = tools.find((t: any) => t.name === name).inputSchema;

      expect(schema.required).toEqual(["user_goal", "tool_name"]);
      expect(Object.keys(schema.properties)).toEqual(
        expect.arrayContaining(["what_happened", "tool_name"]),
      );
      expect(schema.properties).not.toHaveProperty("signal_type");
      // A vendor tool that happens to take the same name is left alone.
      expect(tools.find((t: any) => t.name === "lookup").inputSchema.required).not.toContain(
        "tool_name",
      );
    },
  );

  it("serves a report that leaves tool_name out, and sends it as null", async () => {
    const { sink, annotate } = await connected();
    expect(await annotate({ user_goal: "look something up", what_happened: "it failed" })).toEqual(
      { ok: true },
    );
    expect(annotations(sink)).toHaveLength(1);
    expect(annotations(sink)[0]!.payload.tool_name).toBeNull();
  });

  it("a report does not use up the session's synthesised proactive", async () => {
    const { sink, client, annotate } = await connected();
    await annotate({ user_goal: "look something up", what_happened: "it failed" });
    await client.callTool({ name: "lookup", arguments: { name: "a", user_goal: "find a" } });
    expect(annotations(sink).map((e) => e.payload.intent_source)).toEqual([null, "injected_param"]);
  });
});
