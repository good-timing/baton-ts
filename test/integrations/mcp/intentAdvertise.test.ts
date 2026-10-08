/**
 * `intentParamMode: "required"` advertises `user_goal` and `expected_result`
 * as required and never enforces them, on both SDK majors, through a real
 * client.
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
  buildExpectedResultParamDescription,
  buildUserGoalParamDescription,
  INSTRUCTIONS_SUBAGENT_CLAUSE,
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

/** One tool Baton injects into, and one each that declares its own
 * `user_goal` or `expected_result`. */
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
    async (args: any) => ({ content: [{ type: "text" as const, text: `q=${String(args.q)}` }] }),
  );
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
  it("leads with REQUIRED under 'required', as Python's does, and keeps the body", () => {
    const body =
      "One sentence: what the user is actually trying to accomplish " +
      "with this call (their goal, not a restatement of the arguments).";
    expect(buildUserGoalParamDescription({ intentParamMode: "required" })).toBe(`REQUIRED. ${body}`);
    expect(buildUserGoalParamDescription({ intentParamMode: "optional" })).toBe(`OPTIONAL. ${body}`);
    expect(buildUserGoalParamDescription()).toBe(`OPTIONAL. ${body}`);
  });
});

describe("the expected_result description", () => {
  it("leads with REQUIRED under 'required', as Python's does, and keeps the body", () => {
    const body =
      "One sentence: what a successful result should look like, so a " +
      "silent/thin failure can be told apart from success.";
    expect(buildExpectedResultParamDescription({ intentParamMode: "required" })).toBe(
      `REQUIRED. ${body}`,
    );
    expect(buildExpectedResultParamDescription({ intentParamMode: "optional" })).toBe(
      `OPTIONAL. ${body}`,
    );
    expect(buildExpectedResultParamDescription()).toBe(`OPTIONAL. ${body}`);
  });
});

describe("requiredParamNames", () => {
  it("names all three under 'required', and nothing otherwise", () => {
    expect(requiredParamNames("required")).toEqual(["user_goal", "expected_result", "overall_task"]);
    expect(requiredParamNames("optional")).toEqual([]);
    expect(requiredParamNames("off")).toEqual([]);
  });
});

describe.each(MAJORS.map((m) => [m.label, m] as const))("on %s", (_label, major) => {
  it("advertises the three names as required under the default, and never one a tool declares itself", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    const handle = install(server);
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual([
      "name",
      "user_goal",
      "expected_result",
      "overall_task",
    ]);
    expect(schemas.lookup.properties.user_goal.description).toBe(
      buildUserGoalParamDescription({ intentParamMode: "required" }),
    );
    expect(schemas.lookup.properties.expected_result.description).toBe(
      buildExpectedResultParamDescription({ intentParamMode: "required" }),
    );
    // A name the vendor declared stays as they wrote it; the other is still Baton's.
    expect(schemas.own_goal.required).toEqual(["q", "expected_result", "overall_task"]);
    expect(schemas.own_expected.required).toEqual(["q", "user_goal", "overall_task"]);
    // Baton's own tool is not wrapped, so nothing is added to it.
    expect(schemas[handle.annotationToolName].required).toEqual(["user_goal"]);
  });

  it("serves a call with NEITHER name: the vendor's result, no error, no intent on the event", async () => {
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
      intent_source: null,
    });
  });

  it("carries both onto the start event when the call sends them, and strips them from the vendor", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server);
    const client = await major.connect(server);

    const res = await client.callTool({
      name: "lookup",
      arguments: {
        name: "alice",
        user_goal: "open the customer record",
        expected_result: "one record for alice",
      },
    });
    expect(res.isError).toBeFalsy();
    expect(vendorSaw).toEqual([{ name: "alice" }]);
    expect(startEvent().payload).toMatchObject({
      call_intent: "open the customer record",
      call_expected: "one record for alice",
      intent_source: "injected_param",
    });
  });

  it("advertises neither name as required under 'optional'", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server, { intentParamMode: "optional" });
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual(["name"]);
    expect(schemas.lookup.properties.user_goal.description).toMatch(/^OPTIONAL\. /);
    expect(schemas.lookup.properties.expected_result.description).toMatch(/^OPTIONAL\. /);
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
    expect(required.seam_augmentations.intent_param.required_names).toEqual([
      "expected_result",
      "overall_task",
      "user_goal",
    ]);
  });

  it("wraps a tools/list handler the SDK installs AFTER withBaton", async () => {
    // No tools yet, so the handler does not exist at install: it lands when
    // withBaton registers its annotate tool, through the patched setter.
    const server = major.make();
    install(server);
    registerVendorTools(major, server);
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual([
      "name",
      "user_goal",
      "expected_result",
      "overall_task",
    ]);
    expect(schemas.own_goal.required).toEqual(["q", "expected_result", "overall_task"]);
  });

  it("tells a delegating agent to pass the turn number, unless no tool takes it", async () => {
    const withParams = major.make();
    registerVendorTools(major, withParams);
    install(withParams);
    const sentence = (await major.connect(withParams)).getInstructions() as string;
    expect(sentence.endsWith(INSTRUCTIONS_SUBAGENT_CLAUSE)).toBe(true);

    const off = major.make();
    registerVendorTools(major, off);
    install(off, { intentParamMode: "off" });
    expect((await major.connect(off)).getInstructions()).not.toContain("subagent");
  });

  it.each(["before", "after"] as const)(
    "drops that sentence when a tool registered %s withBaton declares its own overall_task",
    async (when) => {
      const server = major.make();
      const registerOwn = () =>
        major.tool(server, "own_task", { overall_task: z.string().optional() }, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
      if (when === "before") registerOwn();
      install(server);
      if (when === "after") registerOwn();
      const client = await major.connect(server);

      const instructions = client.getInstructions() as string;
      expect(instructions).not.toContain("subagent");
      expect(instructions).toContain("Acme");
      // The vendor's own param is left as they wrote it, and never advertised as ours.
      expect((await listed(client)).own_task.required ?? []).not.toContain("overall_task");
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

    expect(schemas.lookup.required).toEqual([
      "name",
      "user_goal",
      "expected_result",
      "overall_task",
    ]);
  });
});
