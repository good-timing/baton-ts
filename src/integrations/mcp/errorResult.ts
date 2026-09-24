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

/** The `error_body` cap, in CODE POINTS, shared by both failure legs (SPEC
 * §11.4.3's two shapes) so a change to the limit cannot move one and leave
 * the other. Python caps the same field at the same number, and its `[:2000]`
 * counts code points — which is why the cut goes through `capCodePoints` and
 * not `String.prototype.slice`. */
export const ERROR_BODY_MAX_CODE_POINTS = 2000;

/**
 * True if `value` is a tool result carrying MCP's error flag.
 *
 * ⚠ **No `content`-must-be-a-list guard, and SPEC §11.4.3 now scopes that
 * rule by VANTAGE POINT rather than requiring it of every producer** — the
 * section said "MUST" unconditionally until 2026-09-24, and this package is
 * why it moved.
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
 * `errorResult.test.ts` asserts it directly: **for a failure the handler
 * itself reports, this predicate agrees with what the client received.**
 *
 * ⚠ **That scope is load-bearing, because a failure the SDK manufactures
 * ABOVE this wrap point is invisible here.** Measured 2026-09-24 on both
 * majors: a tool registered with an `outputSchema` whose handler returns
 * `content` and no `structuredContent` returns a success-shaped object, so
 * this predicate correctly answers false — and then the SDK's own output
 * validation, which runs after the executor, sends the client
 * `{isError: true, content: [{text: "Output validation error: …"}]}`. Baton
 * files `tool_call_end`. Nothing at the handler's vantage point can see it;
 * closing it needs a wrap above the request handler, or a sensor on the wire
 * — which is what `baton-proxy` is, and why the wire probe recorded that the
 * floor an SDK cannot see, the proxy can.
 *
 * ⚠ **And moving THIS sensor up to the request handler would cost more than
 * it closed**, which is why the gap is recorded rather than chased: both
 * majors convert a thrown handler error into a returned `isError` inside that
 * handler (`mcp.js:135`, `mcp-DXXb3Vv3.mjs:1404`), so above it the two failure
 * shapes are the same object and `error_type` collapses to `tool_error` for
 * both. Python's vector pins `"error_type": "ValueError"`. The throw/return
 * distinction only exists BELOW the request handler, which is where this sits.
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
 * ⚠ **No truncation here, deliberately.** The caller cuts AFTER scrubbing, to
 * `ERROR_BODY_MAX_CODE_POINTS`, on both failure legs alike.
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
      if (typeof text !== "string") continue;
      const trimmed = text.trim();
      if (trimmed) parts.push(trimmed);
    }
  } catch {
    return "";
  }
  return parts.join("\n");
}
