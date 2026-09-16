/**
 * The context object every `McpServer` tool callback receives, whether
 * registered via `registerTool` or the annotation tool.
 *
 * Declared structurally rather than imported, for two reasons. Two shapes
 * wear this name — the official SDK 1.x passes `RequestHandlerExtra`, the v2
 * packages pass their own `ServerContext` — and importing either one would
 * pin this package to that major even for a type, which `tsup`'s `.d.ts`
 * rollup then re-exports into `dist/index.d.ts` and a consumer without that
 * package fails to typecheck against. Only the fields declared below are
 * ever read — three for `_meta`/session, two more for headers.
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
  /** 1.x: the transport request's headers, as a plain object whose values may
   * be a STRING, an ARRAY of strings (a repeated header line), or undefined. */
  requestInfo?: { headers?: unknown } | undefined;
  /** v2: HTTP transport info. `req` is the transport request and its
   * `headers` is a Web `Headers`.
   *
   * ⚠ **`req` IS declared — this comment said it was not, and that was wrong.**
   * Corrected 2026-09-16 against the installed package. `ServerContext` declares
   * `http?: { req?: globalThis.Request; closeSSE?: ... }`, documented "The
   * original HTTP request", at
   * `@modelcontextprotocol/server@2.0.0/dist/createMcpHandler-CLhGwQTn.d.mts:2212`.
   * The `{ authInfo? }`-only shape the old text described is real but is
   * `BaseContext.http` (`:2171`) — a DIFFERENT block, which `ServerContext`
   * intersects, so the member carries both. Two declarations of one property
   * name, and the earlier pass read the wrong one and generalised.
   *
   * The old text also warned "do not correct this back on the strength of the
   * `.d.ts`", which is why the exact file and line are cited above rather than
   * the claim repeated: the way past that warning is a narrower read, not a
   * louder assertion. Measurement still backs it — 10 rows, both majors, every
   * transport (v15 probe) — so this is now declared AND measured. */
  http?: { req?: { headers?: unknown } | undefined } | undefined;
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

/** The call's HTTP headers as ONE shape, whichever major delivered them.
 *
 * ⚠ **This exists because the two majors disagree twice over**, and a vendor
 * hook must not have to know which one it is running under:
 *
 * | | where | shape |
 * |---|---|---|
 * | 1.x | `extra.requestInfo.headers` | plain object; a repeated header is an ARRAY |
 * | v2  | `extra.http.req.headers` | Web `Headers`, case-insensitive |
 *
 * Left unnormalized, `headers["X-Forwarded-User"]` returns a string on one
 * major, an array when the header repeats, and `undefined` on the other — and
 * because the SDK peers type this position loosely, nothing warns the vendor.
 * That is register A8 (fixed in the Python SDK 2026-09-13, where one adapter
 * delivered a case-insensitive mapping and the other a lowercased dict) about
 * to happen again in TypeScript, so it is absorbed HERE rather than shipped.
 *
 * Web `Headers` is the normalized shape because it is the platform's own
 * answer to this question: lookups fold case, and repeated values join with
 * `", "` by a rule the standard defines — unlike the Python side, where the
 * two upstreams disagree on first-wins vs last-wins and neither joins.
 *
 * Returns `null` when no HTTP request is in flight, which is every stdio call
 * and the normal case. `null` means "no HTTP request", never "the client sent
 * no headers".
 */
/** What we observed beneath this call, for the envelope's `transport_observed`.
 *
 * `"http"` when a transport request object is reachable — `requestInfo` on the
 * 1.x peer, `http.req` on v2. `"no-http-request"` when neither is, which is
 * stdio and in-memory. `"read-failed"` if reading the carrier throws.
 *
 * ⚠ **Keyed on the REQUEST OBJECT, never on {@link extraHeaders}.** That
 * function ends in a bare `return null` and — by its own contract above —
 * returns `null` both when no HTTP request is in flight AND when a header it
 * was handed could not be appended (the HTTP/2 pseudo-header guard). So an
 * HTTP call whose headers it declined reads there as no-HTTP. That fold is
 * harmless for identity, which only loses a lookup, and NOT harmless here:
 * `"no-http-request"` is a licence, not a label — SPEC §3.4 lets a consumer
 * group a process-wide fallback `session_id` on it and only on it. Handing
 * that out because a header was malformed merges two strangers.
 *
 * ⚠ The v15 probe measured ZERO folds across 10 rows, so this is not a bug we
 * have seen — it is one the shape allows, and Python's equivalent helper has
 * the same fold as a LIVE defect (register A6). Same rule on both SDKs, for the
 * same reason, before either can bite.
 *
 * There is no `null` return. `null` on the envelope means the SDK did not look,
 * which is the library path with no MCP transport at all; every caller here is
 * inside a live MCP call and did look. */
export function observeTransport(extra: Extra): string {
  try {
    const carrier = extra.http?.req ?? extra.requestInfo;
    return carrier ? "http" : "no-http-request";
  } catch {
    return "read-failed";
  }
}

export function extraHeaders(extra: Extra): Headers | null {
  const fromV2 = extra.http?.req?.headers as Headers | undefined;
  // Duck-typed rather than `instanceof Headers`. A `Headers` built in another
  // realm — a `vm` context, a framework's fetch shim, a bundled polyfill —
  // fails `instanceof`, and the fallthrough would then return `null`, which
  // this function's contract defines as "no HTTP request is in flight". That
  // statement would be FALSE: the hook would see stdio semantics on an
  // authenticated HTTP call and identity would silently disappear.
  if (fromV2 && typeof fromV2.get === "function") return fromV2;

  const fromV1 = extra.requestInfo?.headers;
  if (fromV1 && typeof fromV1 === "object") {
    const headers = new Headers();
    for (const [name, value] of Object.entries(fromV1 as Record<string, unknown>)) {
      // `undefined` is a declared value of 1.x's header record, and passing it
      // to `append` would stringify it into the literal text "undefined" —
      // a header that exists and holds a lie, which reads downstream as a
      // client that sent something.
      // An array is a repeated header line. Appending each lets `Headers`
      // apply the platform's join rule rather than inventing one here.
      //
      // Anything that is not a string is SKIPPED rather than coerced. The 1.x
      // type says `string | string[] | undefined`, but this value arrives as
      // `unknown` from a peer we do not control, and `String({})` yields the
      // literal text "[object Object]" — a header that exists and holds a
      // lie, which downstream reads as a client that sent something. Refusing
      // to invent a value is the same rule the null-vs-absent distinction on
      // `headers` itself follows.
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item !== "string") continue;
        try {
          headers.append(name, item);
        } catch {
          // ⚠ **`Headers.append` REJECTS names and values the 1.x peer will
          // really hand us, and an identity read may not fail a tool call.**
          // `SSEServerTransport` passes Node's `req.headers` through verbatim,
          // and under Node's HTTP/2 compatibility API that object carries the
          // pseudo-headers `:path` / `:method` / `:authority` / `:scheme` —
          // `append(":path", …)` throws `TypeError: invalid header name`, and
          // a CR/LF-bearing value from a custom transport throws the same way.
          // Unguarded, that escapes this function, escapes the context builder,
          // and 500s EVERY tool call on an HTTP/2 deployment before the
          // vendor's own handler runs. Skipping the offending header degrades
          // identity for that one header; letting it propagate takes down the
          // server.
        }
      }
    }
    return headers;
  }
  return null;
}
