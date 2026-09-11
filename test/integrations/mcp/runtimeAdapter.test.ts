/**
 * Pins that a CALLER CANNOT ASSERT ITS OWN RUNTIME.
 *
 * This file exists because the thing it guards is an absence, and an absence
 * that nothing asserts is one edit away from coming back. `detectAgentRuntime`
 * used to honour an `_meta.baton.agent_runtime` override; Python removed both
 * spellings of it (the nested form at B5, the reverse-DNS `io.baton/*` form on
 * 2026-09-09, SPEC §5.2: "Recognized keys: none"), and this package kept
 * reading the nested one for a further day — two sensors watching one client
 * and disagreeing about what it is.
 *
 * ⚠ Nothing ever SENT either form, so deleting the branch reddened no test
 * here and could not have: the coverage gap and the dead code were the same
 * fact. Mirrors `baton`'s `tests/test_runtime_adapter.py`
 * (`test_no_client_override_is_honoured_in_any_form`) case for case, because
 * parity between the sensors is the property that was actually broken.
 */
import { describe, expect, it } from "vitest";

import { detectAgentRuntime } from "../../../src/integrations/mcp/runtimeAdapter.js";

describe("detectAgentRuntime", () => {
  it("answers claude-code from the claudecode/ prefix", () => {
    expect(detectAgentRuntime({ "claudecode/toolUseId": "tu_1" })).toBe("claude-code");
  });

  it("treats progressToken alone as no signal", () => {
    // Cursor's shape per SPEC §5.2 — and Claude Code sends it too, so matching
    // on it would attribute every Cursor call to Claude Code.
    expect(detectAgentRuntime({ progressToken: 7 })).toBeNull();
  });

  it.each([
    ["pre-B5 nested form", { baton: { agent_runtime: "acme-plugin" } }],
    ["reverse-DNS form", { "io.baton/agent_runtime": "acme-plugin" }],
  ])("ignores a client override — %s", (_label, meta) => {
    expect(detectAgentRuntime(meta as Record<string, unknown>)).toBeNull();
  });

  it("does not let an override suppress the heuristic", () => {
    // The removal must not have left a half-read key that can still LOSE us a
    // detection: the heuristic answers regardless of what else is in `_meta`.
    expect(
      detectAgentRuntime({
        baton: { agent_runtime: "acme-plugin" },
        "claudecode/toolUseId": "tu_1",
      }),
    ).toBe("claude-code");
  });

  it("returns null for absent meta", () => {
    expect(detectAgentRuntime(null)).toBeNull();
  });
});
