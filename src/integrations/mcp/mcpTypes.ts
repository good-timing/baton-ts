/**
 * The context object every `McpServer` tool callback receives, whether
 * registered via `registerTool` or the annotation tool.
 *
 * Declared structurally rather than imported, for two reasons. Two shapes
 * wear this name — the official SDK 1.x passes `RequestHandlerExtra`, the v2
 * packages pass their own `ServerContext` — and importing either one would
 * pin this package to that major even for a type, which `tsup`'s `.d.ts`
 * rollup then re-exports into `dist/index.d.ts` and a consumer without that
 * package fails to typecheck against. Only these three fields are ever read.
 *
 * The divergence that matters: v2's `ServerContext` is
 * `{ sessionId, mcpReq, http }` (measured 2026-08-28) — it keeps `sessionId`
 * but moves the request `_meta` down under `mcpReq`. Read only at the 1.x
 * location and every v2 session silently degrades to
 * `agent_runtime: "unknown"` with no `runtime_meta`: no error, just worse
 * data. Use {@link extraMeta}, never `extra._meta`.
 */
export interface Extra {
  /** Transport-supplied session id; present on both majors. */
  sessionId?: string | undefined;
  /** 1.x: the request's `_meta`, at the top level. */
  _meta?: unknown;
  /** v2's `ServerContext.mcpReq` — the in-flight JSON-RPC request. */
  mcpReq?: { _meta?: unknown } | undefined;
}

/** The call's `_meta`, from wherever this SDK major keeps it. */
export function extraMeta(extra: Extra): Record<string, unknown> | null {
  const direct = extra._meta as Record<string, unknown> | undefined;
  if (direct) return direct;
  const nested = extra.mcpReq?._meta as Record<string, unknown> | undefined;
  return nested ?? null;
}
