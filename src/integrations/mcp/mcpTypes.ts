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
 *
 * The SECOND divergence, same shape, measured 2026-09-11: v2 LIFTS every
 * reserved `io.modelcontextprotocol/*` key OUT of the `_meta` a handler sees
 * and re-exposes them under `mcpReq.envelope`. Sending one identical
 * hand-crafted `_meta` to both majors, `io.modelcontextprotocol/clientInfo`
 * arrived in `extra._meta` on sdk 1.30.0 and in `ctx.mcpReq.envelope` on
 * server 2.0.0, whose `_meta` retained only the unreserved
 * `claudecode/toolUseId`. So a reserved key read at the 1.x location alone
 * is a silent `unknown` across the whole v2 major. Use {@link extraEnvelope}.
 */
export interface Extra {
  /** Transport-supplied session id; present on both majors. */
  sessionId?: string | undefined;
  /** 1.x: the request's `_meta`, at the top level — reserved keys INCLUDED. */
  _meta?: unknown;
  /** v2's `ServerContext.mcpReq` — the in-flight JSON-RPC request.
   * `envelope` holds the reserved `io.modelcontextprotocol/*` keys this
   * major lifts out of `_meta`; absent entirely when the request carried
   * none, which is the common case on a 2025-11-25 connection. */
  mcpReq?: { _meta?: unknown; envelope?: unknown } | undefined;
}

/** The call's `_meta`, from wherever this SDK major keeps it.
 *
 * ⚠ On v2 this is `_meta` MINUS the reserved keys — see {@link extraEnvelope}
 * for those. It is the right input for the `claudecode/*` heuristic and for
 * `runtime_meta`, and the wrong one for anything `io.modelcontextprotocol/*`. */
export function extraMeta(extra: Extra): Record<string, unknown> | null {
  const direct = extra._meta as Record<string, unknown> | undefined;
  if (direct) return direct;
  const nested = extra.mcpReq?._meta as Record<string, unknown> | undefined;
  return nested ?? null;
}

/** The reserved `io.modelcontextprotocol/*` keys v2 lifts out of `_meta`.
 *
 * Null on 1.x, where nothing is lifted and the keys stay in `extraMeta`'s
 * result — so a reader wanting a reserved key must consult BOTH, and finding
 * nothing here is the normal 1.x answer rather than an absent client. */
export function extraEnvelope(extra: Extra): Record<string, unknown> | null {
  const envelope = extra.mcpReq?.envelope as Record<string, unknown> | undefined;
  return envelope ?? null;
}
