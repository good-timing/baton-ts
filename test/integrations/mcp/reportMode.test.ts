/** `reportMode` on both SDK majors: off by default, the annotation tool and
 * its instructions only when it is `"on"`. The Python SDK's twin is
 * `tests/functional/test_report_mode_parity.py`. */

import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateBatonConfig } from "../../../src/integrations/mcp/config.js";
import {
  buildServerInstructions,
  INTENT_INSTRUCTIONS,
} from "../../../src/integrations/mcp/llmText.js";
import { CapturingSink, install, MAJORS, type Major } from "./_majors.js";

let warnings: string[];

beforeEach(() => {
  warnings = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ON_TEXT = buildServerInstructions({
  vendorDisplayName: "Acme",
  annotationToolName: "vendor_annotate",
});

async function served(
  major: Major,
  options: { instructions?: string; tools?: string[]; ownGoal?: boolean } = {},
  config: Parameters<typeof install>[2] = {},
) {
  const sink = new CapturingSink();
  const server = major.make(
    options.instructions === undefined ? {} : { instructions: options.instructions },
  );
  for (const name of options.tools ?? ["lookup"]) {
    major.tool(server, name, { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "found" }],
    }));
  }
  if (options.ownGoal) {
    major.tool(server, "approve", { doc: z.string(), user_goal: z.string().optional() }, () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
  }
  const handle = install(server, sink, config);
  const client = await major.connect(server);
  const { tools } = await client.listTools();
  const seam = async (call: string, args: Record<string, unknown>) => {
    await client.callTool({ name: call, arguments: args });
    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    return (snapshot.payload as { seam_augmentations: Record<string, unknown> })
      .seam_augmentations;
  };
  return {
    sink,
    handle,
    client,
    seam,
    names: (tools as { name: string }[]).map((t) => t.name).sort(),
    instructions: (client.getInstructions() as string | undefined) ?? "",
  };
}

describe.each(MAJORS)("reportMode on $label", (major) => {
  it("by default registers no annotation tool, and serves only the subagent sentence", async () => {
    const s = await served(major);
    expect(s.names).toEqual(["lookup"]);
    expect(s.instructions).toBe(INTENT_INSTRUCTIONS);
    expect(s.handle.annotationToolName).toBe("");
  });

  it("keeps the vendor's instructions above the sentence", async () => {
    const s = await served(major, { instructions: "Use lookup for names." });
    expect(s.instructions).toBe(`Use lookup for names.\n\n${INTENT_INSTRUCTIONS}`);
  });

  it("keeps the vendor's instructions above the reports text", async () => {
    const s = await served(major, { instructions: "Use lookup for names." }, { reportMode: "on" });
    expect(s.instructions).toBe(`Use lookup for names.\n\n${ON_TEXT}`);
  });

  it("captures a vendor tool named like the annotation tool", async () => {
    const s = await served(major, { tools: ["vendor_annotate"] });
    await s.client.callTool({
      name: "vendor_annotate",
      arguments: { name: "x", user_goal: "1: note; success is ok" },
    });
    const starts = s.sink.events.filter((e) => e.event_type === "tool_call_start");
    expect(starts.map((e) => (e.payload as { tool_name: string }).tool_name)).toEqual([
      "vendor_annotate",
    ]);
  });

  it("serves the annotation tool and its instructions under reportMode 'on'", async () => {
    const s = await served(major, {}, { reportMode: "on" });
    expect(s.names).toEqual(["lookup", "vendor_annotate"]);
    expect(s.handle.annotationToolName).toBe("vendor_annotate");
    expect(s.instructions).toBe(ON_TEXT);
  });

  it("warns that annotationToolName has no effect without reports, and registers nothing", async () => {
    const s = await served(major, {}, { annotationToolName: "acme_report" });
    expect(s.names).toEqual(["lookup"]);
    expect(s.instructions).toBe(INTENT_INSTRUCTIONS);
    expect(warnings.join("")).toContain(
      'annotationToolName="acme_report" has no effect with reportMode: "off"',
    );
  });

  it.each([undefined, "Use approve for docs."])(
    "a tool with its own user_goal removes the sentence, leaving the vendor's text (%s)",
    async (vendorText) => {
      const s = await served(major, {
        tools: [],
        ownGoal: true,
        ...(vendorText !== undefined && { instructions: vendorText }),
      });
      expect(s.instructions).toBe(vendorText ?? "");
      expect((await s.seam("approve", { doc: "d" })).instructions_suffix).toBe(false);
    },
  );

  it("still says Baton's text is gone after the tool that removed it is removed", async () => {
    const sink = new CapturingSink();
    const server = major.make();
    major.tool(server, "lookup", { name: z.string() }, () => ({
      content: [{ type: "text" as const, text: "found" }],
    }));
    major.tool(server, "approve", { user_goal: z.string().optional() }, () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    install(server, sink);
    (server as { _registeredTools: Record<string, { remove(): void }> })._registeredTools.approve!.remove();
    const client = await major.connect(server);
    await client.callTool({ name: "lookup", arguments: { name: "a" } });

    expect((client.getInstructions() as string | undefined) ?? "").toBe("");
    const snapshot = sink.events.find((e) => e.event_type === "surface_snapshot")!;
    const payload = snapshot.payload as {
      tools: Record<string, unknown>[];
      seam_augmentations: Record<string, unknown>;
    };
    expect(payload.tools.map((t) => t.name)).toEqual(["lookup"]);
    expect(payload.seam_augmentations.instructions_suffix).toBe(false);
  });

  it("keeps the reports text, without the sentence, beside a native user_goal", async () => {
    const s = await served(major, { tools: [], ownGoal: true }, { reportMode: "on" });
    expect(s.instructions).not.toContain("subagent");
    expect((await s.seam("approve", { doc: "d" })).instructions_suffix).toBe(true);
  });

  it.each(["off", "on"] as const)(
    "says in the snapshot what Baton added, reports %s",
    async (reportMode) => {
      const s = await served(major, {}, { reportMode });
      const seam = await s.seam("lookup", { name: "a" });
      expect(seam.instructions_suffix).toBe(true);
      expect(seam.injected_tools).toEqual(reportMode === "off" ? [] : ["vendor_annotate"]);
    },
  );
});

describe("validation", () => {
  const base = { vendorId: "v", consentToken: "ct" };

  it("needs a display name only with reports on", () => {
    expect(() => validateBatonConfig(base)).not.toThrow();
    expect(() => validateBatonConfig({ ...base, reportMode: "on" })).toThrow(
      /needs a vendorDisplayName with reportMode: "on"/,
    );
  });

  it("refuses intentParamMode 'off' unless reports are on", () => {
    expect(() => validateBatonConfig({ ...base, intentParamMode: "off" })).toThrow(
      /nothing\s+would capture/,
    );
    expect(() =>
      validateBatonConfig({
        ...base,
        vendorDisplayName: "V",
        intentParamMode: "off",
        reportMode: "on",
      }),
    ).not.toThrow();
  });

  it("refuses a reportMode it does not know", () => {
    expect(() => validateBatonConfig({ ...base, reportMode: "yes" as never })).toThrow(
      /reportMode "yes" must be one of/,
    );
  });
});
