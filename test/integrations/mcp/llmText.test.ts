/**
 * The text an agent reads. It is the Python SDK's, byte for byte: both
 * wrappers inject the same params into the same vendor schemas, so a
 * difference is a difference in what two agents are told to do.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import vectors from "./llmTextVectors.json" with { type: "json" };
import {
  buildAnnotationToolDescription,
  buildExpectedResultParamDescription,
  buildOverallTaskParamDescription,
  buildServerInstructions,
  buildUserGoalParamDescription,
  INSTRUCTIONS_SUBAGENT_CLAUSE,
  OVERALL_TASK_PARAM_NAME,
  requiredParamNames,
} from "../../../src/integrations/mcp/llmText.js";

describe("overall_task param description", () => {
  it("asks for the turn number first and keeps the repeat-verbatim contract", () => {
    const text = buildOverallTaskParamDescription();
    expect(text).toContain("'3: prepare campaign approval'");
    expect(text).toContain("REPEAT the exact same label text after the colon");
    expect(OVERALL_TASK_PARAM_NAME).toBe("overall_task");
  });
});

// The retired agent-facing names. All three are still WIRE keys, so they
// legitimately appear across the codebase — but never in text an agent reads,
// where they would name a param the schema no longer accepts.
const RETIRED_AGENT_FACING_NAMES = ["intent", "expected_outcome", "workflow"];

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
    expect(buildServerInstructions({ ...names, intentParamMode: "off" })).toBe(
      c.instructions_intent_params_off,
    );
    expect(buildAnnotationToolDescription({ vendorDisplayName: c.vendor_display_name })).toBe(
      c.description,
    );
  });
  it.each(["required", "optional"] as const)(
    "is byte-identical for the three param descriptions under '%s'",
    (intentParamMode) => {
      expect({
        user_goal: buildUserGoalParamDescription({ intentParamMode }),
        expected_result: buildExpectedResultParamDescription({ intentParamMode }),
        overall_task: buildOverallTaskParamDescription({ intentParamMode }),
      }).toEqual(vectors.param_descriptions[intentParamMode]);
    },
  );

  it("requires the same names, and adds the same subagent sentence", () => {
    expect(requiredParamNames("required")).toEqual(vectors.required_param_names);
    expect(INSTRUCTIONS_SUBAGENT_CLAUSE).toBe(vectors.subagent_clause);
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
