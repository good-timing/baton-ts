import type { Extra } from "./mcpTypes.js";

/** Real per-call session id, shared by the tool-call wrapper and the
 * annotation tool so both file events under the same id. Falls back to the
 * transport-supplied `extra.sessionId`, then the process-wide fallback.
 *
 * ⚠ **Rung 0 — `BatonConfig.resolveSessionId` — was REMOVED 2026-09-12**,
 * mirroring Python. It keyed the session on an identifier the SDK did not
 * mint, which is what retired the `_meta` rungs on the Python side: a
 * vendor's handle differs from a client's only in who supplied it, and the
 * join rule does not draw that line. What a vendor knows about a caller
 * belongs in `user_id` — which this SDK cannot yet populate at all (no
 * identity hook exists here; tracked on sdk-hardening). */
export async function resolveSessionId(
  fallbackSessionId: string,
  extra: Extra,
): Promise<string> {
  if (typeof extra.sessionId === "string" && extra.sessionId) return extra.sessionId;
  return fallbackSessionId;
}
