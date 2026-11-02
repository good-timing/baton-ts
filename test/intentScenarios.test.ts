/**
 * The injected `user_goal` against `baton-spec`'s fake collector, in every
 * scenario of `collector/intent.json`; what each checks is the file's
 * `about`. Skipped where `python3` is missing, which the collector needs.
 */
import { describe, expect, it } from "vitest";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { HttpSink } from "../src/sinks.js";
import { connectInMemory, echoServer, hasPython, scenarioFile, startCollector, toolEvents } from "./_scenarios.js";

const MEMBERS = ["call_intent", "call_expected", "call_workflow", "intent_source"] as const;

interface Scenario {
  name: string;
  arguments: Record<string, unknown>;
  expect: { params: Record<string, unknown> } & Partial<Record<(typeof MEMBERS)[number], string | null>>;
}

const spec = scenarioFile<{ scenarios: Scenario[] }>("intent.json");

/** Scenarios this SDK does not run, with the reason. */
const NOT_RUN: Record<string, string> = {};

describe.skipIf(!hasPython)("the injected user_goal against the fake collector", () => {
  it.each(spec.scenarios.filter((s) => !(s.name in NOT_RUN)))("keeps SPEC §5.1.2: $name", async (scenario) => {
    const port = await startCollector("ok");
    const server = echoServer();
    const handle = withBaton(server, {
      vendorId: "acme",
      vendorDisplayName: "Acme",
      consentToken: "ct",
      sink: new HttpSink(`http://127.0.0.1:${port}`, { apiKey: "k" }),
    });
    const client = await connectInMemory(server);

    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "echo")!.inputSchema;
    expect(schema.properties?.user_goal).toMatchObject({ type: "string" });
    expect(schema.required).toContain("user_goal");

    const result = await client.callTool({ name: "echo", arguments: scenario.arguments });
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: scenario.arguments.text }]);
    await handle.aclose();

    const starts = (await toolEvents(port)).filter((e) => e.event_type === "tool_call_start");
    expect(starts).toHaveLength(1);
    const payload = starts[0]!.payload as Record<string, unknown>;
    expect(payload.params).toEqual(scenario.expect.params);
    for (const member of MEMBERS) {
      expect(payload[member] ?? null, member).toBe(scenario.expect[member] ?? null);
    }
  });
});
