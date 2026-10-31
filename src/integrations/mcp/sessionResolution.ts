import { uuid7 } from "../../uuid7.js";
import { extraHeaders, observeTransport, type Extra } from "./mcpTypes.js";

/** A `session_id` with the envelope's `session_id_origin` (SPEC §11.4). The
 * rung that answered decides the origin, never the id's spelling. */
export interface ResolvedSession {
  sessionId: string;
  origin: "observed" | "minted";
  perCall: boolean;
}

/** SPEC §3.4 rungs 4 and 5. The header is read as well as `extra.sessionId`
 * because a stateless transport reports no id even when the client sends one.
 *
 * No vendor hook: an id the SDK did not mint must not key the session (the
 * join rule). What a vendor knows about a caller goes in `principal`. */
export async function resolveSessionId(
  fallbackSessionId: string,
  extra: Extra,
): Promise<ResolvedSession> {
  if (typeof extra.sessionId === "string" && extra.sessionId) {
    return { sessionId: extra.sessionId, origin: "observed", perCall: false };
  }
  const fromHeader = sessionIdFromHeader(extra);
  if (fromHeader !== null) return { sessionId: fromHeader, origin: "observed", perCall: false };
  if (observeTransport(extra) === "http") {
    return { sessionId: `sdk-${uuid7()}`, origin: "minted", perCall: true };
  }
  return { sessionId: fallbackSessionId, origin: "minted", perCall: false };
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
