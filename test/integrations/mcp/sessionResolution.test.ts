/**
 * The session-id ladder, after rung 0 was removed.
 *
 * **Why this file exists.** `BatonConfig.resolveSessionId` was removed
 * 2026-09-12 and the suite did not move: 290 tests before, 290 after. Probing
 * further, deleting the SURVIVING `extra.sessionId` rung outright also passed
 * all 290 — so the whole of `resolveSessionId` was untested, not merely the
 * hook. A removal verified by a suite that cannot see the function is not
 * verified, so the residue gets the coverage the hook never had.
 *
 * Asserted at the function, not through a server: the two rungs are a total
 * function of `(fallbackSessionId, extra)` and driving a transport to reach
 * them would test the transport's id, not the ladder's choice between them.
 */

import { describe, expect, it } from "vitest";
import { resolveSessionId } from "../../../src/integrations/mcp/sessionResolution.js";
import type { Extra } from "../../../src/integrations/mcp/mcpTypes.js";

const extra = (sessionId?: unknown): Extra => ({ sessionId }) as unknown as Extra;

describe("resolveSessionId", () => {
  it("prefers the transport session id over the process-wide fallback", async () => {
    expect(await resolveSessionId("install-fallback", extra("from-transport"))).toBe(
      "from-transport",
    );
  });

  it("falls back when the transport carries no session id", async () => {
    expect(await resolveSessionId("install-fallback", extra(undefined))).toBe("install-fallback");
  });

  it("falls back on an EMPTY transport session id rather than filing under ''", async () => {
    // An empty string is falsy but is still a string, so a `typeof` check
    // alone would let it through and file every such call under one id —
    // the merge-strangers shape rung 4's blank guard exists for on the
    // Python side.
    expect(await resolveSessionId("install-fallback", extra(""))).toBe("install-fallback");
  });

  it("falls back on a NON-STRING transport session id", async () => {
    // `Extra` is the MCP SDK's own shape and this value crosses a library
    // boundary; a number here would otherwise become a `session_id` of the
    // wrong type on the wire.
    expect(await resolveSessionId("install-fallback", extra(42))).toBe("install-fallback");
    expect(await resolveSessionId("install-fallback", extra(null))).toBe("install-fallback");
  });

  it("does not consult any vendor hook — rung 0 is gone", async () => {
    // The signature is the assertion: two parameters, neither of them a
    // callable. Pinned so re-adding a hook to this function is a deliberate
    // act with a test to update, not a quiet restoration of the rung the
    // join rule rejected.
    expect(resolveSessionId.length).toBe(2);
  });
});
