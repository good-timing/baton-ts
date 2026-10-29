/**
 * The text an agent reads. It is the Python SDK's, byte for byte: both
 * wrappers inject the same params into the same vendor schemas, so a
 * difference is a difference in what two agents are told to do.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import vectors from "./llmTextVectors.json" with { type: "json" };
import {
  buildAnnotationToolDescription,
  buildServerInstructions,
  buildUserGoalParamDescription,
  INSTRUCTIONS_SUBAGENT_CLAUSE,
  INTENT_INSTRUCTIONS,
  requiredParamNames,
  withVendorInstructions,
} from "../../../src/integrations/mcp/llmText.js";

// The retired agent-facing names. They still appear across the codebase, as
// wire keys or as names a stale client may send — but never in text an agent
// reads, where they would name a param the schema no longer accepts.
const RETIRED_AGENT_FACING_NAMES = [
  "intent",
  "expected_outcome",
  "workflow",
  "expected_result",
  "overall_task",
];

describe("agent-facing text", () => {
  it("never asks for a param name that was retired", () => {
    // Matched only where a param is REFERENCED — `name:`, `name (REQUIRED`, or
    // inside the `a + b + c` populate list. A bare word-boundary search
    // over-detects: "you satisfied the user's intent via a workaround" is prose
    // and correct, and `intent_source` is a real field.
    //
    // The Python sibling shipped exactly this bug — its lead line still said
    // "intent + expected_outcome + workflow" after the params were renamed,
    // with every presence-checking test green, because none of them asked
    // whether a retired name was still there. An agent following that line
    // sends params that are dropped on arrival.
    const surfaces: Record<string, string> = {
      instructions: buildServerInstructions({
        vendorDisplayName: "Acme",
        annotationToolName: "acme_annotate",
      }),
      toolDescription: buildAnnotationToolDescription({ vendorDisplayName: "Acme" }),
    };
    for (const [where, text] of Object.entries(surfaces)) {
      for (const retired of RETIRED_AGENT_FACING_NAMES) {
        const referenced = new RegExp(
          `\\b${retired}(?=:)|\\b${retired} \\(REQUIRED|(?<=\\+ )${retired}\\b|\\b${retired}(?= \\+)`,
        );
        expect(referenced.test(text), `${where} still names ${retired}`).toBe(false);
      }
    }
  });
});

describe("the report wording", () => {
  const instructions = buildServerInstructions({
    vendorDisplayName: "Acme",
    annotationToolName: "acme_annotate",
  });
  const description = buildAnnotationToolDescription({ vendorDisplayName: "Acme" });

  it("asks for one report per user request and the word none for no tool", () => {
    expect(instructions).toContain("once per user request, not per call");
    expect(instructions).toContain("tool_name (none if no tool)");
    expect(description).toContain("Write none if no tool exists for the request");
  });

  it.each(['""', "empty string", "signal_type"])("never says %s", (retired) => {
    expect(instructions).not.toContain(retired);
    expect(description).not.toContain(retired);
  });
});

// Python's own rendering, generated from the release named in the file's
// `generated_by`, whose default (`proactive_mode="off"`) text this arm carries.
// Regenerate it from Python rather than editing it by hand: the point is that
// the comparison is against what the other SDK actually emits.
describe("parity with the Python SDK's rendered text", () => {
  it.each(vectors.cases)("is byte-identical for $vendor_display_name", (c) => {
    const names = {
      vendorDisplayName: c.vendor_display_name,
      annotationToolName: c.annotation_tool_name,
    };
    expect(buildServerInstructions(names)).toBe(c.instructions);
    expect(buildAnnotationToolDescription({ vendorDisplayName: c.vendor_display_name })).toBe(
      c.description,
    );
  });
  it.each(["required", "optional"] as const)(
    "is byte-identical for the user_goal description under '%s'",
    (intentParamMode) => {
      expect({ user_goal: buildUserGoalParamDescription({ intentParamMode }) }).toEqual(
        vectors.param_descriptions[intentParamMode],
      );
    },
  );

  it("requires the same names, and adds the same subagent sentence", () => {
    expect(requiredParamNames("required")).toEqual(vectors.required_param_names);
    expect(INSTRUCTIONS_SUBAGENT_CLAUSE).toBe(vectors.subagent_clause);
    expect(INTENT_INSTRUCTIONS).toBe(vectors.intent_instructions);
  });
});

describe("the retired 'support-signal' wording", () => {
  it("occurs nowhere under src/", () => {
    // Every file, not just the rendered text, so the phrase cannot survive in
    // a comment for a later edit to copy back into a template.
    const src = fileURLToPath(new URL("../../../src", import.meta.url));
    const hits = readdirSync(src, { recursive: true, encoding: "utf8" })
      .map((rel) => join(src, rel))
      .filter((path) => statSync(path).isFile())
      .filter((path) => readFileSync(path, "utf8").includes("support-signal"));
    expect(hits).toEqual([]);
  });
});

describe("withVendorInstructions", () => {
  const ours = INTENT_INSTRUCTIONS;

  it("puts the vendor's text first, and ours alone when they have none", () => {
    expect(withVendorInstructions({ _instructions: "Vendor text." }, ours)).toBe(
      `Vendor text.\n\n${ours}`,
    );
    expect(withVendorInstructions({ _instructions: "  " }, ours)).toBe(ours);
    expect(withVendorInstructions({}, ours)).toBe(ours);
  });

  it("replaces our paragraph on a second install rather than adding another", () => {
    const server: { _instructions?: string } = { _instructions: "Vendor text." };
    server._instructions = withVendorInstructions(server, ours);
    const reports = buildServerInstructions({
      vendorDisplayName: "Acme",
      annotationToolName: "acme_annotate",
    });
    expect(withVendorInstructions(server, reports)).toBe(`Vendor text.\n\n${reports}`);
  });

  it("takes text the vendor set between two installs as theirs", () => {
    const server: { _instructions?: string } = { _instructions: "Old." };
    server._instructions = withVendorInstructions(server, ours);
    server._instructions = "New.";
    expect(withVendorInstructions(server, ours)).toBe(`New.\n\n${ours}`);
  });

  it("warns when the two together pass what Claude Code keeps", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      withVendorInstructions({ _instructions: "x".repeat(2100) }, ours);
      expect(String(write.mock.calls[0]?.[0])).toMatch(/Claude Code cuts them at ~2087/);
    } finally {
      write.mockRestore();
    }
  });
});
