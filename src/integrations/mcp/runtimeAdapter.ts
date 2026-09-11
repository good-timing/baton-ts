/**
 * Per-runtime `_meta` heuristics — detect which agent runtime is calling
 * the vendor's MCP server. Mirrors `baton` (Python)'s
 * `integrations/runtime_adapter.py::detect_agent_runtime`.
 *
 * Per SPEC §5.2: different runtimes populate MCP's `_meta` differently
 * (Claude Code adds `claudecode/toolUseId`; Cursor only sets
 * `progressToken`; Claude Desktop sets nothing).
 *
 * ⚠ **A caller cannot assert its own runtime.** This used to read an
 * `_meta.baton.agent_runtime` override; Python removed both spellings of it
 * (the nested form at B5, the reverse-DNS `io.baton/*` form on 2026-09-09)
 * and this is the same removal, not a port of the old behaviour. Two sensors
 * watching one client must not disagree about what it is, and the value here
 * is self-reported — never attested — so an override would let the thing
 * being measured choose its own label. Detection answers only from signals
 * the SDK derives itself.
 */

export function detectAgentRuntime(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;

  for (const key of Object.keys(meta)) {
    if (key.startsWith("claudecode/")) return "claude-code";
  }

  return null;
}
