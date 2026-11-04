/** `reportTool` is the annotation tool each MCP adapter registers (SPEC §5.6). */

import { describe, expect, it } from "vitest";

import { Client, reportTool, type Event } from "../../src/index.js";
import { CapturingSink, install, MAJORS } from "../integrations/mcp/_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DISPLAY_NAME = "Acme Data";

const tool = () => reportTool({ vendorDisplayName: DISPLAY_NAME });

const REPORT = {
  user_goal: "2: find the row; success is one row",
  what_happened: "The search returned every row.",
  tool_name: "search",
  suggested_improvement: "Filter by id.",
  context: { likely_cause: "no filter" },
};

describe.each(MAJORS)("on $label", (major) => {
  async function registered() {
    const sink = new CapturingSink();
    const server = new (major.make().constructor)({ name: DISPLAY_NAME, version: "1.0.0" });
    install(server, sink, { vendorDisplayName: DISPLAY_NAME, reportMode: "on" });
    const client = await major.connect(server);
    const { tools } = await client.listTools();
    const [listed] = tools;
    const refused = await client.callTool({
      name: listed.name,
      arguments: { user_goal: "1: x", tool_name: "none" },
    });
    return { sink, client, listed, refused: JSON.parse(refused.content[0].text).error };
  }

  it("is the data the adapter registers", async () => {
    const { client, listed, refused } = await registered();
    const listedSchema = { ...listed.inputSchema };
    delete listedSchema.$schema;

    expect(tool().name).toBe(listed.name);
    expect(tool().description).toBe(listed.description);
    expect(tool().inputSchema).toEqual(listedSchema);
    expect(tool().instructions).toBe(client.getInstructions());
    expect(tool().refusal).toBe(refused);
  });

  it("sends the payload the adapter sends", async () => {
    const { sink: adapterSink, client: mcp, listed } = await registered();
    await mcp.callTool({ name: listed.name, arguments: REPORT });
    const sink = new CapturingSink();
    const client = new Client({ sink, vendorId: "acme" });

    await client.annotate(tool().annotateArgs(REPORT)!);
    await client.flush();

    const payload = (events: Event[]) => events.find((event) => event.event_type === "annotation")?.payload;
    expect(payload(sink.events)).toEqual(payload(adapterSink.events));
  });
});

describe("annotateArgs", () => {
  it("maps a report to annotate() and drops what annotate() does not take", () => {
    expect(
      tool().annotateArgs({
        ...REPORT,
        expected_result: "retired",
        overall_task: "retired",
        signal_type: "unknown",
      }),
    ).toEqual({
      intent: REPORT.user_goal,
      whatHappened: REPORT.what_happened,
      toolName: "search",
      suggestedImprovement: "Filter by id.",
      context: { likely_cause: "no filter" },
    });
  });

  it.each(["none", ""])("sends tool_name %j as the agent wrote it", (toolName) => {
    expect(tool().annotateArgs({ what_happened: "No tool exports.", tool_name: toolName })).toEqual({
      whatHappened: "No tool exports.",
      toolName,
    });
  });

  it.each([undefined, null, "", "  \n", 7])(
    "is null with what_happened %j: an intent-only note is no report (SPEC §5.6 rule 1)",
    (whatHappened) => {
      expect(
        tool().annotateArgs({ user_goal: "1: x; success is y", tool_name: "search", what_happened: whatHappened }),
      ).toBeNull();
    },
  );

  it("drops an empty value, as the Python helper does", () => {
    expect(
      tool().annotateArgs({ what_happened: "Broke.", user_goal: "", suggested_improvement: "", context: {} }),
    ).toEqual({ whatHappened: "Broke." });
  });

  it("drops a value of the wrong type", () => {
    expect(
      tool().annotateArgs({ what_happened: "Broke.", tool_name: 3, user_goal: ["x"], context: ["a"] }),
    ).toEqual({ whatHappened: "Broke." });
  });
});

describe("reportTool", () => {
  it("validates a name as the adapters do", () => {
    expect(reportTool({ vendorDisplayName: DISPLAY_NAME, name: "acme_report" }).name).toBe("acme_report");
    expect(() => reportTool({ vendorDisplayName: DISPLAY_NAME, name: "acme.report" })).toThrow(
      /cross-runtime/,
    );
    expect(() => reportTool({ vendorDisplayName: DISPLAY_NAME, name: "" })).toThrow(/cross-runtime/);
  });

  it.each(["!!!", "FastMCP", "mcp-server", "A".repeat(2000)])(
    "asks for a name for display name %j",
    (displayName) => {
      expect(() => reportTool({ vendorDisplayName: displayName })).toThrow(/Pass name/);
    },
  );

  it("says which names to shorten when an explicit name does not fit", () => {
    expect(() => reportTool({ vendorDisplayName: "A".repeat(2000), name: "acme_report" })).toThrow(
      /Shorten one of them/,
    );
  });

  it("gives each tool its own schema", () => {
    (tool().inputSchema.properties as Record<string, unknown>).user_goal = undefined;

    expect((tool().inputSchema.properties as Record<string, unknown>).user_goal).toBeDefined();
  });
});
