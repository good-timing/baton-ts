/**
 * Per-runtime `_meta` heuristics — detect which agent runtime is calling
 * the vendor's MCP server. Mirrors `baton` (Python)'s
 * `integrations/fastmcp/runtime_adapter.py::detect_agent_runtime`.
 *
 * Per SPEC §5.2: different runtimes populate MCP's `_meta` differently
 * (Claude Code adds `claudecode/toolUseId`; Cursor only sets
 * `progressToken`; Claude Desktop sets nothing). Vendors MAY override the
 * heuristic by setting `_meta.baton.agent_runtime` explicitly.
 */

export function detectAgentRuntime(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;

  const batonMeta = meta["baton"];
  if (batonMeta && typeof batonMeta === "object") {
    const runtime = (batonMeta as Record<string, unknown>)["agent_runtime"];
    if (typeof runtime === "string" && runtime) return runtime;
  }

  for (const key of Object.keys(meta)) {
    if (key.startsWith("claudecode/")) return "claude-code";
  }

  return null;
}
