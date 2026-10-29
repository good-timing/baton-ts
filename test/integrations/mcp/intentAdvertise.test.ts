/**
 * `intentParamMode: "required"` advertises `user_goal` as required and never
 * enforces it, on both SDK majors, through a real client.
 *
 * The advertisement is made on the `tools/list` RESPONSE by the seam in
 * withBaton.ts, and the zod schema stays optional. So the cases below ask two
 * things of the same kind of install: what the agent is shown, and what
 * happens when the agent ignores it.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";

import { withBaton } from "../../../src/integrations/mcp/withBaton.js";
import type { BatonConfig } from "../../../src/integrations/mcp/config.js";
import {
  buildUserGoalParamDescription,
  INTENT_INSTRUCTIONS,
  requiredParamNames,
} from "../../../src/integrations/mcp/llmText.js";
import { CapturingSink, MAJORS, type Major } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

let sink: CapturingSink;
let vendorSaw: Record<string, unknown>[];

beforeEach(() => {
  sink = new CapturingSink();
  vendorSaw = [];
});

/** One tool Baton injects into, one that declares its own `user_goal`, and
 * one that declares a retired name, `expected_result`. */
function registerVendorTools(major: Major, server: any): void {
  major.tool(server, "lookup", { name: z.string() }, async (args: any) => {
    vendorSaw.push({ ...args });
    return { content: [{ type: "text" as const, text: `found ${String(args.name)}` }] };
  });
  major.tool(
    server,
    "own_goal",
    { q: z.string(), user_goal: z.string().optional() },
    async (args: any) => ({ content: [{ type: "text" as const, text: `q=${String(args.q)}` }] }),
  );
  major.tool(
    server,
    "own_expected",
    { q: z.string(), expected_result: z.string().optional() },
    async (args: any) => {
      vendorSaw.push({ ...args });
      return { content: [{ type: "text" as const, text: `q=${String(args.q)}` }] };
    },
  );
}

function registerLookup(major: Major, server: any): void {
  major.tool(server, "lookup", { name: z.string() }, async () => ({
    content: [{ type: "text" as const, text: "found" }],
  }));
}

function install(server: any, config: Partial<BatonConfig> = {}) {
  return withBaton(server, {
    vendorId: "acme",
    vendorDisplayName: "Acme",
    consentToken: "ct",
    sink,
    ...config,
  });
}

async function listed(client: any): Promise<Record<string, any>> {
  const { tools } = (await client.listTools()) as {
    tools: Array<{ name: string; inputSchema: Record<string, any> }>;
  };
  return Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
}

function startEvent() {
  return sink.events.find((e) => e.event_type === "tool_call_start")!;
}

describe("the user_goal description", () => {
  it("leads with REQUIRED under 'required' and OPTIONAL otherwise, with one body", () => {
    const required = buildUserGoalParamDescription({ intentParamMode: "required" });
    const optional = buildUserGoalParamDescription({ intentParamMode: "optional" });
    expect(required).toMatch(/^REQUIRED\. Write it as '<n>: /);
    expect(optional).toBe(`OPTIONAL. ${required.slice("REQUIRED. ".length)}`);
    expect(buildUserGoalParamDescription()).toBe(optional);
  });
});

describe("requiredParamNames", () => {
  it("names user_goal under 'required', and nothing otherwise", () => {
    expect(requiredParamNames("required")).toEqual(["user_goal"]);
    expect(requiredParamNames("optional")).toEqual([]);
    expect(requiredParamNames("off")).toEqual([]);
  });
});

describe.each(MAJORS.map((m) => [m.label, m] as const))("on %s", (_label, major) => {
  it("advertises user_goal as required under the default, and never on a tool that declares it", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server);
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual(["name", "user_goal"]);
    expect(schemas.lookup.properties.user_goal.description).toBe(
      buildUserGoalParamDescription({ intentParamMode: "required" }),
    );
    expect(schemas.own_goal.required).toEqual(["q"]);
    expect(schemas.own_expected.required).toEqual(["q", "user_goal"]);
    expect(schemas.lookup.properties).not.toHaveProperty("expected_result");
    expect(schemas.lookup.properties).not.toHaveProperty("overall_task");
  });

  it("advertises tool_name on the annotate tool, which gets no user_goal of ours", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    const handle = install(server, { reportMode: "on" });
    const schemas = await listed(await major.connect(server));

    expect(schemas[handle.annotationToolName].required).toEqual(["user_goal", "tool_name"]);
  });

  it("serves a call with no user_goal: the vendor's result, no error, no intent on the event", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server);
    const client = await major.connect(server);

    const res = await client.callTool({ name: "lookup", arguments: { name: "alice" } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("found alice");
    expect(vendorSaw).toEqual([{ name: "alice" }]);
    expect(startEvent().payload).toMatchObject({
      tool_name: "lookup",
      call_intent: null,
      call_expected: null,
      call_workflow: null,
      intent_source: null,
    });
  });

  it("carries user_goal onto the start event, and strips it from the vendor", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server);
    const client = await major.connect(server);

    const res = await client.callTool({
      name: "lookup",
      arguments: { name: "alice", user_goal: "1: open alice's record; success is one record" },
    });
    expect(res.isError).toBeFalsy();
    expect(vendorSaw).toEqual([{ name: "alice" }]);
    expect(startEvent().payload).toMatchObject({
      call_intent: "1: open alice's record; success is one record",
      call_expected: null,
      call_workflow: null,
      intent_source: "injected_param",
    });
  });

  it("records a stale client's retired names, and strips them from the vendor", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server);
    const client = await major.connect(server);
    await listed(client);

    const res = await client.callTool({
      name: "lookup",
      arguments: {
        name: "alice",
        user_goal: "open the customer record",
        expected_result: "one record for alice",
        overall_task: "2: customer lookup",
      },
    });
    expect(res.isError).toBeFalsy();
    expect(vendorSaw).toEqual([{ name: "alice" }]);
    expect(startEvent().payload).toMatchObject({
      call_intent: "open the customer record",
      call_expected: "one record for alice",
      call_workflow: "2: customer lookup",
    });
  });

  it("serves a stale client's call to a tool whose schema refuses unknown keys", async () => {
    const server = major.make();
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    register("strict", { inputSchema: z.strictObject({ text: z.string() }) }, async (args: any) => {
      vendorSaw.push({ ...args });
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    install(server);
    const client = await major.connect(server);
    await listed(client);

    const res = await client.callTool({
      name: "strict",
      arguments: { text: "hi", user_goal: "1: g", expected_result: "e", overall_task: "2: t" },
    });
    expect(res.isError).toBeFalsy();
    expect(vendorSaw).toEqual([{ text: "hi" }]);
    expect(startEvent().payload).toMatchObject({ call_expected: "e", call_workflow: "2: t" });
  });

  it("gives a tool called in-process none of the outer call's retired names", async () => {
    const server = major.make();
    major.tool(server, "b", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "b" }],
    }));
    major.tool(server, "a", { name: z.string() }, async () => {
      const entry = server._registeredTools.b;
      await (entry.executor ?? entry.handler)({ name: "inner" }, {});
      return { content: [{ type: "text" as const, text: "a" }] };
    });
    install(server);
    const client = await major.connect(server);
    await client.callTool({
      name: "a",
      arguments: { name: "x", expected_result: "E", overall_task: "1: T" },
    });

    const starts = sink.events
      .filter((e) => e.event_type === "tool_call_start")
      .map((e) => e.payload as { tool_name: string; call_expected: unknown; call_workflow: unknown })
      .map((p) => [p.tool_name, p.call_expected, p.call_workflow]);
    expect(starts).toEqual([
      ["a", "E", "1: T"],
      ["b", null, null],
    ]);
  });

  it("records a nested rejected call's retired names from its own request, not the outer one's", async () => {
    const innerSink = new CapturingSink();
    const inner = major.make();
    major.tool(inner, "inner", { n: z.number() }, () => ({
      content: [{ type: "text" as const, text: "x" }],
    }));
    withBaton(inner, { vendorId: "b", vendorDisplayName: "B", consentToken: "ct", sink: innerSink });
    const innerClient = await major.connect(inner);
    await listed(innerClient);

    const outer = major.make();
    major.tool(outer, "outer", { q: z.string() }, async () => {
      await innerClient.callTool({ name: "inner", arguments: { n: "not a number" } }).catch(() => {});
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    install(outer);
    const outerClient = await major.connect(outer);
    await listed(outerClient);
    await outerClient.callTool({
      name: "outer",
      arguments: { q: "x", expected_result: "OUTER expected", overall_task: "OUTER task" },
    });

    const innerStarts = innerSink.events.filter((e) => e.event_type === "tool_call_start");
    expect(innerStarts).toHaveLength(1);
    expect(innerStarts[0]!.payload).toMatchObject({ call_expected: null, call_workflow: null });
  });

  it("forwards a retired name the tool declares itself, and records nothing for it", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server);
    const client = await major.connect(server);

    await client.callTool({
      name: "own_expected",
      arguments: { q: "x", expected_result: "the vendor's own value" },
    });
    expect(vendorSaw).toEqual([{ q: "x", expected_result: "the vendor's own value" }]);
    expect(startEvent().payload).toMatchObject({ call_expected: null });
  });

  it("advertises nothing as required under 'optional'", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server, { intentParamMode: "optional" });
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual(["name"]);
    expect(schemas.lookup.properties.user_goal.description).toMatch(/^OPTIONAL\. /);
  });

  it("emits the same surface hash under 'optional' and 'required'", async () => {
    const surfaceFor = async (mode: "optional" | "required") => {
      sink = new CapturingSink();
      const server = major.make();
      registerVendorTools(major, server);
      install(server, { intentParamMode: mode });
      const client = await major.connect(server);
      await client.callTool({ name: "lookup", arguments: { name: "alice" } });
      const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
      return snapshot.payload as unknown as {
        surface_hash: string;
        seam_augmentations: { intent_param: { mode: string; required_names: string[] } };
      };
    };

    const optional = await surfaceFor("optional");
    const required = await surfaceFor("required");
    expect(required.surface_hash).toBe(optional.surface_hash);
    // The mode is reported beside the hash, never inside it.
    expect(optional.seam_augmentations.intent_param.mode).toBe("optional");
    expect(required.seam_augmentations.intent_param.mode).toBe("required");
    expect(optional.seam_augmentations.intent_param.required_names).toEqual([]);
    expect(required.seam_augmentations.intent_param.required_names).toEqual(["user_goal"]);
  });

  it("wraps a tools/list handler the SDK installs AFTER withBaton", async () => {
    // No tools yet, so the handler does not exist at install: it lands with
    // the vendor's first tool, through the patched setter.
    const server = major.make();
    install(server);
    registerVendorTools(major, server);
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual(["name", "user_goal"]);
    expect(schemas.own_goal.required).toEqual(["q"]);
  });

  it("tells a delegating agent to pass the turn number, unless no tool takes it", async () => {
    const withParams = major.make();
    registerLookup(major, withParams);
    install(withParams);
    expect((await major.connect(withParams)).getInstructions()).toBe(INTENT_INSTRUCTIONS);

    const off = major.make();
    registerLookup(major, off);
    install(off, { intentParamMode: "off", reportMode: "on" });
    expect((await major.connect(off)).getInstructions()).not.toContain("subagent");
  });

  it.each([
    ["before", "off"],
    ["after", "off"],
    ["before", "on"],
    ["after", "on"],
  ] as const)(
    "drops that sentence when a tool registered %s withBaton declares its own user_goal, reports %s",
    async (when, reportMode) => {
      const server = major.make();
      const registerOwn = () =>
        major.tool(server, "own_goal", { user_goal: z.string().optional() }, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
      if (when === "before") registerOwn();
      install(server, { reportMode });
      if (when === "after") registerOwn();
      const client = await major.connect(server);

      const instructions = client.getInstructions() ?? "";
      expect(instructions).not.toContain("subagent");
      if (reportMode === "on") expect(instructions).toContain("Acme");
      else expect(instructions).toBe("");
      // The vendor's own param is left as they wrote it, and never advertised as ours.
      expect((await listed(client)).own_goal.required ?? []).not.toContain("user_goal");
    },
  );

  it("wraps a tools/list handler that already exists at install", async () => {
    // Declaring the tools capability makes v2 install the handler at
    // construction; on 1.x the vendor's own first tool does it. Either way it
    // is in the dispatch map before withBaton runs.
    const server = major.make({ eagerTools: true });
    registerVendorTools(major, server);
    install(server);
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual(["name", "user_goal"]);
  });
});
