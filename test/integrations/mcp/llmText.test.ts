/**
 * Pins the injected `overall_task` description to the wording the granularity
 * experiment selected.
 *
 * This text is not a style choice: it is the outcome of 40 paired live-agent
 * sessions (baton-internal `spikes/overall_task_a5/`, A5b + A5c, 2026-08-11).
 * Two wordings were scored and they fail in opposite directions — the shipped
 * one misses unannounced task boundaries (0.700) but never splits a task that
 * should stay whole (0.000), while the candidate detects every boundary
 * (1.000) and relabels *within* one task (0.200 then 0.400 on identical
 * scripts). The trade went to the shipped text because shattering is the
 * failure mode that destroys downstream trust.
 *
 * The candidate was reverted in the Python SDK and the revert never reached
 * this package, which shipped the rejected wording undetected because nothing
 * here read this module. That is the drift this file exists to catch: the
 * first assertion is the pin, the second names the rejected text explicitly so
 * a future re-introduction fails by name rather than by diff.
 */
import { describe, expect, it } from "vitest";

import {
  buildOverallTaskParamDescription,
  OVERALL_TASK_PARAM_NAME,
} from "../../../src/integrations/mcp/llmText.js";

// Byte-for-byte the Python SDK's `_OVERALL_TASK_PARAM_DESCRIPTION`
// (`baton/src/baton/integrations/_llm_text.py`). Both wrappers inject the same
// param into the same vendor schemas, so a difference here is a difference in
// what two agents are told to do with one grouping key.
const SELECTED_WORDING =
  "OPTIONAL. Short stable label for the broader task this call serves " +
  "(e.g. 'prepare campaign approval'). REPEAT the exact same string on " +
  "every call serving the same task; change it only when the user starts " +
  "a different task.";

describe("overall_task param description", () => {
  it("is byte-identical to the Python SDK's selected wording", () => {
    expect(buildOverallTaskParamDescription()).toBe(SELECTED_WORDING);
  });

  it("does not carry the rejected over-splitting candidate", () => {
    const text = buildOverallTaskParamDescription();
    // Both phrases are load-bearing in the candidate: they are what scoped the
    // label to the current turn rather than the task, producing the A -> B -> A
    // relabel a merge-only consumer resolves as three tasks instead of one.
    expect(text).not.toContain("not the overall theme");
    expect(text).not.toContain("working on right now");
  });

  it("keeps the repeat-verbatim contract that makes the label groupable", () => {
    // Rung 3b groups by exact string match, so the contract IS the mechanism:
    // without it, 80% of adjacent same-task calls reword and every task
    // shatters regardless of which granularity wording is chosen.
    expect(buildOverallTaskParamDescription()).toContain(
      "REPEAT the exact same string",
    );
    expect(OVERALL_TASK_PARAM_NAME).toBe("overall_task");
  });
});
