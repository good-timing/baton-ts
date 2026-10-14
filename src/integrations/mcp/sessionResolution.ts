import { extraHeaders, type Extra } from "./mcpTypes.js";

/** A `session_id` with the envelope's `session_id_origin` (SPEC §11.4). The
 * rung that answered decides the origin, never the id's spelling. */
export interface ResolvedSession {
  sessionId: string;
  origin: "observed" | "minted";
}

/** Real per-call session id, shared by the tool-call wrapper and the
 * annotation tool so both file events under the same id. SPEC §3.4 rung 4:
 * the transport's `extra.sessionId`, else the `mcp-session-id` request header
 * (a stateless transport reports no id even when the client sends one), else
 * the process-wide fallback.
 *
 * ⚠ **Rung 0 — `BatonConfig.resolveSessionId` — was REMOVED 2026-09-12**,
 * mirroring Python. It keyed the session on an identifier the SDK did not
 * mint, which is what retired the `_meta` rungs on the Python side: a
 * vendor's handle differs from a client's only in who supplied it, and the
 * join rule does not draw that line. What a vendor knows about a caller
 * belongs in `principal`, which `BatonConfig.resolvePrincipal` now populates on this
 * SDK (see `principalResolution.ts`). That sentence read "cannot yet populate at
 * all" until the hook landed. */
export async function resolveSessionId(
  fallbackSessionId: string,
  extra: Extra,
): Promise<ResolvedSession> {
  if (typeof extra.sessionId === "string" && extra.sessionId) {
    return { sessionId: extra.sessionId, origin: "observed" };
  }
  const fromHeader = sessionIdFromHeader(extra);
  if (fromHeader !== null) return { sessionId: fromHeader, origin: "observed" };
  return { sessionId: fallbackSessionId, origin: "minted" };
}

/** Blank is a miss, as on the Python side: a whitespace-only id would file
 * every such call under one session. Never throws into the tool call. */
function sessionIdFromHeader(extra: Extra): string | null {
  try {
    const value = extraHeaders(extra)?.get("mcp-session-id")?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}
