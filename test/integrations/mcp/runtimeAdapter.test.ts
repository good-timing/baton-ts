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

import {
  CLIENT_INFO_META_KEY,
  CLIENT_NAME_MAX_LEN,
  detectAgentRuntime,
} from "../../../src/integrations/mcp/runtimeAdapter.js";

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

/**
 * The ladder above the heuristic — declared before inferred.
 *
 * The carriers are NOT Python's and were measured before being used: tier 1
 * lives in `_meta` on sdk 1.x and in the lifted `mcpReq.envelope` on server
 * v2, and tier 2 is on the server object rather than the handler context on
 * BOTH. The round-trip suites (`withBaton*.test.ts`) exercise these against
 * the real peers; these are the branch-level cases a round trip cannot stage.
 */
describe("detectAgentRuntime — the declared tiers", () => {
  const serverNamed = (name: unknown) => ({
    server: { getClientVersion: () => ({ name, version: "1.0.0" }) },
  });

  it("prefers a request-borne declaration over the handshake and the heuristic", () => {
    expect(
      detectAgentRuntime(
        { [CLIENT_INFO_META_KEY]: { name: "on-request" }, "claudecode/toolUseId": "tu_1" },
        { server: serverNamed("on-connection") },
      ),
    ).toBe("on-request");
  });

  it("reads the request-borne declaration from v2's lifted envelope too", () => {
    // The port-killer: v2 lifts every reserved `io.modelcontextprotocol/*`
    // key OUT of the `_meta` the handler sees. Reading only `_meta` — which
    // is what a line-by-line port of Python would do — is a silent `unknown`
    // across that entire major. `meta` here is what v2 actually leaves
    // behind: the unreserved keys only.
    expect(
      detectAgentRuntime(
        { "claudecode/toolUseId": "tu_1" },
        { envelope: { [CLIENT_INFO_META_KEY]: { name: "on-request" } } },
      ),
    ).toBe("on-request");
  });

  it("prefers the handshake over the heuristic", () => {
    // The tier that answers for every client shipping today. Before it
    // existed this call was `claude-code` — an inference from a key whose
    // real meaning is "this metadata originated from Claude Code".
    expect(
      detectAgentRuntime({ "claudecode/toolUseId": "tu_1" }, serverNamed("on-connection")),
    ).toBe("on-connection");
  });

  it("falls through to the heuristic when the handshake names nobody", () => {
    expect(detectAgentRuntime({ "claudecode/toolUseId": "tu_1" }, serverNamed(""))).toBe(
      "claude-code",
    );
    expect(detectAgentRuntime({ "claudecode/toolUseId": "tu_1" }, {})).toBe("claude-code");
  });

  it("never lets a throwing server object reach the vendor's tool call", () => {
    // SPEC §11.2: capture may never fail the call it observes. These are two
    // third-party objects across two majors, free to throw whatever they like
    // outside a live connection — an enumerated catch is a guess about a
    // library, and that guess has already cost one vendor's tool call.
    const throwing = {
      get server(): never {
        throw new Error("no session");
      },
    };
    expect(() => detectAgentRuntime({ "claudecode/toolUseId": "tu_1" }, throwing)).not.toThrow();
    expect(detectAgentRuntime({ "claudecode/toolUseId": "tu_1" }, throwing)).toBe("claude-code");
  });

  it("scrubs and caps the two client-supplied tiers, and neither for the heuristic", () => {
    const shout = (v: unknown) => String(v).toUpperCase();
    expect(detectAgentRuntime(null, { ...serverNamed("quiet"), scrubber: shout })).toBe("QUIET");

    const long = "x".repeat(500);
    expect(detectAgentRuntime(null, serverNamed(long))).toHaveLength(CLIENT_NAME_MAX_LEN);

    // Tier 3's answer is a constant this module owns — scrubbing or capping
    // it would be the opposite mistake.
    expect(
      detectAgentRuntime({ "claudecode/toolUseId": "tu_1" }, { scrubber: shout }),
    ).toBe("claude-code");
  });

  it("loses the TIER, not the ladder, when a scrubber redacts a name", () => {
    // A scrubber returning null — or anything not a string — must not be
    // stringified onto the wire: `String(null)` is `"null"`, which is truthy
    // and would ship as the reported runtime on every event of every call.
    // It falls through to the next tier instead.
    const redact = () => null;
    expect(
      detectAgentRuntime({ "claudecode/toolUseId": "tu_1" }, {
        ...serverNamed("on-connection"),
        scrubber: redact,
      }),
    ).toBe("claude-code");

    // And with nothing below it left to answer, null — never `"null"`.
    expect(detectAgentRuntime(null, { ...serverNamed("on-connection"), scrubber: redact })).toBeNull();
  });
});
