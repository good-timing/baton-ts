/**
 * Detecting MCP's returned error flag. Port of `baton` (Python)'s
 * `integrations/_error_result.py`, with one predicate deliberately different —
 * see `isErrorResult`.
 *
 * SPEC §11.4.3. **A failed MCP tool call is a 200.** The protocol files it as a
 * successful JSON-RPC response whose `CallToolResult` body sets the error flag;
 * a JSON-RPC error means a protocol fault, not a tool failure. So classifying
 * on thrown exceptions alone — which is what §6.1 used to say, and what this
 * package did — files real failures as successes.
 *
 * ⚠ **One spelling, `isError`.** Python's helper probes `is_error` first
 * because that is a Python ATTRIBUTE name the `mcp` 2.x rewrite introduced;
 * MCP's own JSON-RPC schema is camelCase and every server dumps by alias
 * (wire probe, 2026-09-23: seven cells, `is_error` in none of them). The TS
 * SDKs have no snake_case era at all — measured 2026-09-24 on both majors,
 * the value this package sees is the vendor's own literal, camelCase.
 */

/** `error_type` for a returned error, as opposed to a thrown exception whose
 * constructor name is used. Same literal as Python's `TOOL_ERROR_TYPE` and as
 * `baton-extmcp`'s — sensor parity is the point. */
export const TOOL_ERROR_TYPE = "tool_error";

/**
 * True if `value` is a tool result carrying MCP's error flag.
 *
 * ⚠ **No `content`-must-be-a-list guard, and that is a deliberate deviation
 * from the Python helper** — because the two sit at different vantage points.
 * Python's adapter receives a result the library has already converted, so an
 * object carrying an `isError` attribute for its own reasons could reach it
 * and must be excluded. This package wraps the vendor's own executor, so what
 * arrives here is the vendor's LITERAL return, and both majors merge that
 * verbatim into the wire result.
 *
 * Measured 2026-09-24 on `@modelcontextprotocol/sdk` 1.x and
 * `@modelcontextprotocol/server` 2.x: a tool returning `{isError: true,
 * rows: 0}` — no `content` at all — reaches the CLIENT as
 * `{content: [], isError: true}`. There is no such thing here as an object
 * that merely spells the flag: spelling it at the top level of a tool's return
 * IS how a TS tool reports failure. A `content` guard would make this sensor
 * miss a failure its caller can see, which is the one thing it may not do.
 *
 * So the invariant is stronger and simpler than Python's, and
 * `errorResult.test.ts` asserts it directly: **this predicate agrees with what
 * the client received.**
 *
 * Guarded end to end — this runs on the vendor's tool-call path (SPEC §11.2:
 * never block the call), so it fails to False.
 */
export function isErrorResult(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null) return false;
    return Boolean((value as { isError?: unknown }).isError);
  } catch {
    return false;
  }
}

/**
 * The human-readable reason inside an error result.
 *
 * Joins the `content` envelope's text parts, which is where a vendor puts the
 * actual sentence ("You do not have sufficient access to delete this
 * Project"). This is what a human reads in the Console, so the fallback is
 * deliberately NOT `String(result)` — `[object Object]` would put noise where
 * the reason belongs. An empty string says "no reason given", which is honest
 * and which the Console already renders as such.
 *
 * ⚠ **No truncation here, deliberately.** The caller cuts AFTER scrubbing,
 * matching the throw path's `String(scrubber(message)).slice(0, 2000)`.
 * Cutting inside this helper would put the truncation BEFORE the scrubber for
 * one of the two failure shapes and after it for the other — and a PII value
 * straddling the boundary would reach the scrubber as a fragment its pattern
 * cannot match, so the half that survives the cut ships unredacted. That is
 * the bug `/code-review` found in the Python change (`33581cb`); it is not
 * being ported.
 */
export function errorText(value: unknown): string {
  const parts: string[] = [];
  try {
    const content = (value as { content?: unknown })?.content;
    if (!Array.isArray(content)) return "";
    for (const part of content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  } catch {
    return "";
  }
  return parts.join("\n");
}
