/**
 * Which agent runtime is calling the vendor's MCP server.
 *
 * A behaviour port of `baton` (Python)'s
 * `integrations/runtime_adapter.py::detect_agent_runtime`, not a
 * transcription of it: the ladder, the precedence argument and the
 * scrub/cap rule are Python's, while two of the three carriers are
 * different objects on this side and were measured before being used.
 *
 * **Prefer what the client DECLARED over what we can infer.** A client
 * names itself in its `initialize` handshake (`clientInfo`), and that is a
 * declaration; the key-prefix heuristic below is an inference drawn from an
 * artifact built for another purpose — `claudecode/toolUseId` is a per-CALL
 * tool-use id, and reading a caller's identity off its namespace prefix
 * works for one vendor by accident of naming and yields nothing for anyone
 * else. That is why Claude Desktop, Cursor and everything else reported
 * `unknown`, on this SDK as on Python's before the ladder landed.
 *
 * ⚠ **A caller cannot assert its own runtime.** This used to read an
 * `_meta.baton.agent_runtime` override; Python removed both spellings (the
 * nested form at B5, the reverse-DNS `io.baton/*` form on 2026-09-09) and
 * so did this module. Two sensors watching one client must not disagree
 * about what it is, and the value here is self-reported — never attested —
 * so an override would let the thing being measured choose its own label.
 *
 * ## The carriers, measured 2026-09-11 on both supported peers
 *
 * Against `@modelcontextprotocol/sdk` 1.30.0 and
 * `@modelcontextprotocol/server` 2.0.0, over real `InMemoryTransport` round
 * trips, reading what a tool handler actually receives.
 *
 * **Tier 1 has two locations, and reading one is a silent `unknown` across
 * a whole major.** One identical hand-crafted `_meta` carrying
 * `io.modelcontextprotocol/clientInfo` arrived in `extra._meta` on 1.x and
 * in `ctx.mcpReq.envelope` on v2 — which lifts every reserved
 * `io.modelcontextprotocol/*` key out of the `_meta` the handler sees. That
 * is the same shape of bug as Python's `clientInfo`/`client_info`, in a
 * different place, and it is why `envelope` is read here at all.
 *
 * **Tier 2 is not on the context.** Python reads
 * `ctx.session.client_params`; neither TS peer puts client identity on the
 * handler's context at all. Both DO expose the cached handshake on the
 * server object, under the same name: `McpServer.server.getClientVersion()`
 * returned the live `{name, version}` in-handler on 1.30.0 and on 2.0.0.
 * So tier 2's carrier is the server `withBaton` already holds, read lazily
 * per call. Duck-typed, never imported — importing either peer's type pins
 * this package to that major.
 *
 * **Tier 1 is not live traffic on these peers, unlike Python's.**
 * `@modelcontextprotocol/client` 2.0.0 negotiates `2025-11-25` by default
 * and sends `clientInfo` in the handshake only, nothing per-request. The
 * Python module's note that fastmcp 4's own `Client` writes the key on
 * every request does NOT transfer. Tier 1 is built anyway: it is free, it
 * is above tier 2 by the same freshest-declaration argument, and it starts
 * working the day a client moves with no further change here.
 */

/**
 * The per-request carrier for the client's declared identity, reserved by
 * MCP 2026-07-28. `@modelcontextprotocol/server` exports this as
 * `CLIENT_INFO_META_KEY`; the literal is written out instead because the
 * 1.x peer exports no such constant and importing v2's would pin a major
 * for a string.
 */
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

/*
 * ⚠ **Tier 1 is forgeable on 1.x and not on v2, and the module heading above
 * is too absolute about it.** "A caller cannot assert its own runtime" is
 * true of the removed `io.baton/*` override and true on a new-spec
 * connection, where the client LIBRARY writes the reserved key and overwrites
 * anything whoever composed the call planted there. It is NOT true on the
 * 1.x peer: measured, a hand-written
 * `_meta["io.modelcontextprotocol/clientInfo"]` arrives verbatim and
 * outranks the handshake — which is exactly what this package's own
 * "a request-borne declaration outranks the handshake" test demonstrates.
 * So on a 2025-11-25 connection anything composing the tool call can set
 * `agent_runtime` to any string up to the cap, and change it per request.
 *
 * That is not a hole to close here — the value is self-reported at every
 * tier, which is why `agent_runtime` is never attested and `user_id` is a
 * different field on a different condition. It is a limit to state, because
 * the sentence above reads stronger than the tier delivers.
 */

/**
 * Cap on any name the CLIENT supplied. Both declared tiers read arbitrary
 * client text and copy it onto every event of the call, so an unbounded
 * value reaches every HTTP sink payload too. 128 is far above any real
 * client name (`claude-code` is 11) and far below anything worth shipping.
 *
 * The heuristic's own answer is NOT capped or scrubbed — it is a constant
 * this module owns, and mangling it would be the opposite mistake.
 */
import { capCodePoints } from "../../_text.js";

export const CLIENT_NAME_MAX_LEN = 128;

/** What an event reports when no tier answered. A LITERAL, not a knob. */
export const UNKNOWN_AGENT_RUNTIME = "unknown";

/** What `detectAgentRuntime` needs beyond `_meta`, all optional: omitting
 * any one costs that tier and nothing else. */
export interface RuntimeDetectionOptions {
  /** v2's lifted reserved keys (`extraEnvelope`). Null/omitted on 1.x,
   * where the same keys are in `meta` instead. */
  envelope?: Record<string, unknown> | null;
  /** The MCP server object `withBaton` wrapped — tier 2's only carrier on
   * either major. Duck-typed; anything else simply loses the tier. */
  server?: unknown;
  /** The vendor's scrubber, applied to the two CLIENT-SUPPLIED tiers. */
  scrubber?: ((value: unknown) => unknown) | undefined;
}

/**
 * Scrub and cap a CLIENT-SUPPLIED name, or null if it is unusable.
 *
 * Null rather than a sentinel so an empty or scrubbed-away value falls
 * through to the NEXT tier instead of becoming the reported runtime — a
 * vendor scrubber that redacts a name must lose that tier, not the ladder.
 */
function clean(
  name: unknown,
  scrubber: ((value: unknown) => unknown) | undefined,
): string | null {
  if (typeof name !== "string" || !name) return null;
  let cleaned: string = name;
  if (scrubber) {
    const scrubbed = scrubber(cleaned);
    // A scrubber that redacts by returning null — or anything else that is
    // not a string — loses this TIER; it does not get stringified onto the
    // wire. `String(null)` is `"null"`, which is truthy and would ship as
    // the reported runtime on every event of every call; an arbitrary
    // object would ship `"[object Object]"`.
    if (typeof scrubbed !== "string") return null;
    cleaned = scrubbed;
  }
  if (!cleaned) return null;
  // Code points, not UTF-16 units — `capCodePoints` carries the reasoning,
  // which moved there when a second capped field turned out to need it and
  // reintroduced the defect by slicing.
  return capCodePoints(cleaned, CLIENT_NAME_MAX_LEN);
}

/** The declared name off the reserved per-request key, wherever this major
 * keeps it. The value is an object with `name`/`version`. */
function declaredOnRequest(
  meta: Record<string, unknown> | null,
  envelope: Record<string, unknown> | null | undefined,
): unknown {
  for (const source of [envelope, meta]) {
    if (!source) continue;
    const info = source[CLIENT_INFO_META_KEY];
    if (info && typeof info === "object") {
      const name = (info as { name?: unknown }).name;
      if (name !== undefined) return name;
    }
  }
  return undefined;
}

/**
 * The declared name off the server's cached `initialize` handshake.
 *
 * ⚠ **Catches everything, on purpose.** This walks two properties of a
 * third-party object across two majors and seven versions, and they are
 * free to throw whatever they like — a getter that raises outside a live
 * connection is exactly the shape that already escaped into Python's
 * middleware once and failed a vendor's tool call, the one thing SPEC
 * §11.2 says capture may never do. An enumerated catch is a guess about a
 * library; this is a fail-open boundary.
 *
 * ⚠ **Per SERVER INSTANCE, where Python's carrier is per SESSION.**
 * `ctx.session.client_params` is scoped to one session by construction;
 * `getClientVersion()` returns whatever the last `initialize` on THIS object
 * cached. The two agree only while server:session is 1:1, which both peers'
 * documented patterns give (1.x `Protocol.connect` replaces the transport,
 * v2's `createMcpHandler` takes a per-session factory). A vendor wiring one
 * `McpServer` across concurrent sessions would get client A's calls
 * attributed to client B's declared name. Not measured either way — recorded
 * as the honest limit of this carrier rather than implied away.
 */
function declaredOnConnection(options: RuntimeDetectionOptions): unknown {
  try {
    // `options.server` is READ INSIDE the try, never destructured by the
    // caller. Reading a property can itself throw — v2's `McpServer` reaches
    // `.server` through an accessor — and a read hoisted out of here escapes
    // the guard entirely while looking perfectly safe at the call site.
    const server = options.server;
    if (!server) return undefined;
    const inner = (server as { server?: unknown }).server;
    const holder = (inner ?? server) as {
      getClientVersion?: () => { name?: unknown } | undefined;
    };
    if (typeof holder.getClientVersion !== "function") return undefined;
    return holder.getClientVersion()?.name;
  } catch {
    return undefined;
  }
}

/**
 * Return the detected agent runtime, or null if no signal — in which case
 * the caller substitutes {@link UNKNOWN_AGENT_RUNTIME}.
 *
 * Precedence — **declared before inferred**, freshest declaration first.
 * First hit wins:
 *
 * 1. The reserved `io.modelcontextprotocol/clientInfo`, riding the request
 *    itself — read from v2's lifted `envelope` and from 1.x's `_meta`.
 * 2. The same declaration from the `initialize` handshake, cached on the
 *    server. **This is the tier that does the work today**: every shipping
 *    client declares here and nowhere else.
 * 3. Heuristic on key prefixes (`claudecode/*` → `claude-code`). Kept BELOW
 *    both declarations rather than dropped: it is proven coverage, and
 *    discarding proven coverage needs evidence nobody relies on it.
 * 4. null.
 *
 * **The heuristic is LAST on purpose.** A proxy forwards `_meta` verbatim,
 * so `claudecode/*` means "this metadata ORIGINATED from Claude Code", not
 * "the caller IS Claude Code" — while `clientInfo` is the client saying
 * what it is. And the heuristic is a one-vendor hardcode: on top it
 * special-cases Claude Code permanently and makes every new client a code
 * change. Where the two agree (Claude Code direct: declares `claude-code`,
 * sends `claudecode/*`) the order is unobservable either way.
 *
 * Tiers 1-2 return CLIENT-SUPPLIED text, so both are scrubbed and capped;
 * tier 3 returns a constant this module owns and is neither. A tier whose
 * value scrubs away to nothing falls through to the next one.
 *
 * ⚠ **Two things this does NOT claim.** The declared name identifies the
 * IMMEDIATE MCP client, which behind a gateway is the gateway rather than
 * the agent. And it is self-asserted, never attested: a client picks its
 * own `clientInfo`. Attested identity is `user_id`, a different field on a
 * different condition; keep the two claims apart.
 */
export function detectAgentRuntime(
  meta: Record<string, unknown> | null,
  options: RuntimeDetectionOptions = {},
): string | null {
  const { envelope, scrubber } = options;

  // Tier 1 — declared, on the request.
  const onRequest = clean(declaredOnRequest(meta, envelope), scrubber);
  if (onRequest !== null) return onRequest;

  // Tier 2 — declared, on the connection. The tier that answers for every
  // client shipping today, including the ones that were unattributable
  // before it existed. `options` goes in whole, deliberately: see the
  // property-read note in `declaredOnConnection`.
  const onConnection = clean(declaredOnConnection(options), scrubber);
  if (onConnection !== null) return onConnection;

  // Tier 3 — inferred, and last: a key prefix says where the METADATA came
  // from, not who the caller is. Only reached when nobody declared anything.
  if (meta) {
    for (const key of Object.keys(meta)) {
      if (key.startsWith("claudecode/")) return "claude-code";
    }
  }

  return null;
}
