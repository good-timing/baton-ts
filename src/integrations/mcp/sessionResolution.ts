import type { ResolveSessionIdHook } from "./config.js";
import type { Extra } from "./mcpTypes.js";

/** Real per-call session id, shared by the tool-call wrapper and the
 * annotation tool so both file events under the same id. A configured
 * `resolveSessionId` hook is checked first and, on a non-empty return,
 * wins outright — mirrors Python's rung-0 `resolve_session_id_hook`. Below
 * that, falls back to the transport-supplied `extra.sessionId`, then the
 * process-wide fallback. */
export async function resolveSessionId(
  hook: ResolveSessionIdHook | undefined,
  fallbackSessionId: string,
  extra: Extra,
  meta: Record<string, unknown> | null,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (hook) {
    try {
      const hookResult = await hook({ meta, toolName, arguments: args });
      if (typeof hookResult === "string" && hookResult) return hookResult;
    } catch {
      // Never propagate a hook failure — fall through to the ladder below,
      // mirroring Python's resolve_via_hook.
    }
  }
  if (typeof extra.sessionId === "string" && extra.sessionId) return extra.sessionId;
  return fallbackSessionId;
}
