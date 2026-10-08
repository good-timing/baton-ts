/** The envelope's `client_observed` (SPEC §11.4): what the client said about
 * itself, sent uninterpreted. The consumer names the client; this SDK does
 * not, and sends `agent_runtime: "unknown"` on every event. */

import { capCodePoints } from "../../_text.js";
import { extraEnvelope, extraHeaders, extraMeta, type Extra } from "./mcpTypes.js";
import { scrubOrNull } from "./safeScrub.js";

/** The per-request carrier for the client's declaration, reserved by MCP
 * 2026-07-28. Written out because the 1.x peer exports no such constant and
 * importing v2's would pin a major for a string. */
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

// The only headers ever copied. A request also carries credentials, so this
// is a list in the SDK and not a config option: `test/integrations/mcp/clientObserved.test.ts`,
// "never copies a header that is not registered".
const OBSERVED_HEADERS = ["user-agent", "x-anthropic-client"] as const;

const CLIENT_INFO_MAX_LEN = 128;
const HEADER_VALUE_MAX_LEN = 256;

interface ClientObserved {
  info?: { name?: string; version?: string };
  headers?: Partial<Record<(typeof OBSERVED_HEADERS)[number], string>>;
}

/** `scrubber` is required so a call site cannot send these values unscrubbed
 * by leaving it out. */
interface ObserveClientOptions {
  /** The MCP server object that was wrapped: it holds the handshake. */
  server?: unknown;
  scrubber: (value: unknown) => unknown;
}

interface DeclaredClientInfo {
  name?: unknown;
  version?: unknown;
}

const hasText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The pair one source declared, or `undefined` when it holds no text at all,
 * so a malformed declaration on the request does not hide the handshake's. */
function declared(info: unknown): DeclaredClientInfo | undefined {
  if (!info || typeof info !== "object") return undefined;
  const { name, version } = info as DeclaredClientInfo;
  return hasText(name) || hasText(version) ? { name, version } : undefined;
}

/** The request's own declaration. v2 lifts the reserved key out of `_meta`
 * into the envelope and 1.x leaves it in, so both are read. */
function declaredOnRequest(extra: Extra): DeclaredClientInfo | undefined {
  for (const source of [extraEnvelope(extra), extraMeta(extra)]) {
    const found = declared(source?.[CLIENT_INFO_META_KEY]);
    if (found) return found;
  }
  return undefined;
}

/** The handshake's declaration, which neither peer puts on the handler's
 * context: both cache it on the server object. A server object reused for
 * a later connection reports the previous client until the new one
 * initializes. */
function declaredOnConnection(server: unknown): DeclaredClientInfo | undefined {
  if (!server) return undefined;
  const inner = (server as { server?: unknown }).server;
  const holder = (inner ?? server) as {
    getClientVersion?: () => DeclaredClientInfo | undefined;
  };
  if (typeof holder.getClientVersion !== "function") return undefined;
  return declared(holder.getClientVersion());
}

function observedInfo(extra: Extra, options: ObserveClientOptions): ClientObserved["info"] {
  // Both fields come from one source, so the pair is one the client sent.
  const sent = declaredOnRequest(extra) ?? declaredOnConnection(options.server);
  const info: NonNullable<ClientObserved["info"]> = {};
  const name = clean(sent?.name, options.scrubber, CLIENT_INFO_MAX_LEN);
  const version = clean(sent?.version, options.scrubber, CLIENT_INFO_MAX_LEN);
  if (name !== undefined) info.name = name;
  if (version !== undefined) info.version = version;
  return Object.keys(info).length > 0 ? info : undefined;
}

function observedHeaders(extra: Extra, options: ObserveClientOptions): ClientObserved["headers"] {
  const sent = extraHeaders(extra);
  const headers: NonNullable<ClientObserved["headers"]> = {};
  for (const header of OBSERVED_HEADERS) {
    const value = clean(sent?.get(header), options.scrubber, HEADER_VALUE_MAX_LEN);
    if (value !== undefined) headers[header] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function clean(
  value: unknown,
  scrubber: ObserveClientOptions["scrubber"],
  max: number,
): string | undefined {
  if (!hasText(value)) return undefined;
  const scrubbed = scrubOrNull<unknown>(scrubber, value, "client_observed");
  if (!hasText(scrubbed)) return undefined;
  return capCodePoints(scrubbed, max);
}

/** These read a third party's request and server objects, which may throw.
 * One failing read costs its own member, never the other or the call. */
function orNothing<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** `null` when nothing was observed. */
export function observeClient(extra: Extra, options: ObserveClientOptions): ClientObserved | null {
  const info = orNothing(() => observedInfo(extra, options));
  const headers = orNothing(() => observedHeaders(extra, options));
  if (info === undefined && headers === undefined) return null;
  return { ...(info && { info }), ...(headers && { headers }) };
}
