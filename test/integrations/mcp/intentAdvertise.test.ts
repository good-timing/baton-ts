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
import { buildUserGoalParamDescription } from "../../../src/integrations/mcp/llmText.js";
import { CapturingSink, MAJORS, type Major } from "./_majors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

let sink: CapturingSink;
let vendorSaw: Record<string, unknown>[];

beforeEach(() => {
  sink = new CapturingSink();
  vendorSaw = [];
});

/** One tool Baton injects into, and one that declares its own `user_goal`. */
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

describe.each(MAJORS.map((m) => [m.label, m] as const))("on %s", (_label, major) => {
  it("advertises user_goal as required under the default, and not on a tool that declares its own", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    const handle = install(server);
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual(["name", "user_goal"]);
    expect(schemas.lookup.properties.user_goal.description).toBe(
      buildUserGoalParamDescription({ intentParamMode: "required" }),
    );
    // Declared by the vendor as optional, so it stays exactly as they wrote it.
    expect(schemas.own_goal.required).toEqual(["q"]);
    // Baton's own tool requires user_goal natively, and it is not listed twice.
    expect(schemas[handle.annotationToolName].required).toEqual(["user_goal"]);
  });

  it("serves a call WITHOUT user_goal: the vendor's result, no error, no intent on the event", async () => {
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
      intent_source: null,
    });
  });

  it("carries user_goal onto the start event when the call sends it, and strips it from the vendor", async () => {
    const server = major.make();
    registerVendorTools(major, server);
    install(server);
    const client = await major.connect(server);

    const res = await client.callTool({
      name: "lookup",
      arguments: { name: "alice", user_goal: "open the customer record" },
    });
    expect(res.isError).toBeFalsy();
    expect(vendorSaw).toEqual([{ name: "alice" }]);
    expect(startEvent().payload).toMatchObject({
      call_intent: "open the customer record",
      intent_source: "injected_param",
    });
  });

  it("advertises no required user_goal under 'optional'", async () => {
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
        seam_augmentations: { intent_param: { mode: string } };
      };
    };

    const optional = await surfaceFor("optional");
    const required = await surfaceFor("required");
    expect(required.surface_hash).toBe(optional.surface_hash);
    // The mode is reported beside the hash, never inside it.
    expect(optional.seam_augmentations.intent_param.mode).toBe("optional");
    expect(required.seam_augmentations.intent_param.mode).toBe("required");
  });

  it("wraps a tools/list handler the SDK installs AFTER withBaton", async () => {
    // No tools yet, so the handler does not exist at install: it lands when
    // withBaton registers its annotate tool, through the patched setter.
    const server = major.make();
    install(server);
    registerVendorTools(major, server);
    const schemas = await listed(await major.connect(server));

    expect(schemas.lookup.required).toEqual(["name", "user_goal"]);
    expect(schemas.own_goal.required).toEqual(["q"]);
  });

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
