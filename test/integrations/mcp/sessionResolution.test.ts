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
const MINTED = { sessionId: "install-fallback", origin: "minted" };

describe("resolveSessionId", () => {
  it("prefers the transport session id over the process-wide fallback", async () => {
    expect(await resolveSessionId("install-fallback", extra("from-transport"))).toEqual({
      sessionId: "from-transport",
      origin: "observed",
    });
  });

  it("falls back when the transport carries no session id", async () => {
    expect(await resolveSessionId("install-fallback", extra(undefined))).toEqual(MINTED);
  });

  it("falls back on an EMPTY transport session id rather than filing under ''", async () => {
    // An empty string is falsy but is still a string, so a `typeof` check
    // alone would let it through and file every such call under one id —
    // the merge-strangers shape rung 4's blank guard exists for on the
    // Python side.
    expect(await resolveSessionId("install-fallback", extra(""))).toEqual(MINTED);
  });

  it("falls back on a NON-STRING transport session id", async () => {
    // `Extra` is the MCP SDK's own shape and this value crosses a library
    // boundary; a number here would otherwise become a `session_id` of the
    // wrong type on the wire.
    expect(await resolveSessionId("install-fallback", extra(42))).toEqual(MINTED);
    expect(await resolveSessionId("install-fallback", extra(null))).toEqual(MINTED);
  });

  it("reads the mcp-session-id header when the transport reports no id", async () => {
    const v1 = { requestInfo: { headers: { "mcp-session-id": " from-header " } } } as Extra;
    const v2 = {
      http: { req: { headers: new Headers({ "Mcp-Session-Id": "from-header" }) } },
    } as unknown as Extra;
    for (const e of [v1, v2]) {
      expect(await resolveSessionId("install-fallback", e)).toEqual({
        sessionId: "from-header",
        origin: "observed",
      });
    }
  });

  it("prefers the transport's id over the header", async () => {
    const e = {
      sessionId: "from-transport",
      requestInfo: { headers: { "mcp-session-id": "from-header" } },
    } as unknown as Extra;
    expect(await resolveSessionId("install-fallback", e)).toEqual({
      sessionId: "from-transport",
      origin: "observed",
    });
  });

  it("falls back on a blank header or a request that cannot be read", async () => {
    const blank = { requestInfo: { headers: { "mcp-session-id": "  " } } } as Extra;
    const throwing = {
      get http(): never {
        throw new TypeError("unexpected context shape");
      },
    } as unknown as Extra;
    expect(await resolveSessionId("install-fallback", blank)).toEqual(MINTED);
    expect(await resolveSessionId("install-fallback", throwing)).toEqual(MINTED);
  });

  it("does not consult any vendor hook — rung 0 is gone", async () => {
    // The signature is the assertion: two parameters, neither of them a
    // callable. Pinned so re-adding a hook to this function is a deliberate
    // act with a test to update, not a quiet restoration of the rung the
    // join rule rejected.
    expect(resolveSessionId.length).toBe(2);
  });
});
