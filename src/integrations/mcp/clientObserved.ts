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

export interface ClientObserved {
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
  return cleanInfo(declaredOnRequest(extra) ?? declaredOnConnection(options.server), options.scrubber);
}

function cleanInfo(
  sent: DeclaredClientInfo | undefined,
  scrubber: ObserveClientOptions["scrubber"],
): ClientObserved["info"] {
  const info: NonNullable<ClientObserved["info"]> = {};
  const name = clean(sent?.name, scrubber, CLIENT_INFO_MAX_LEN);
  const version = clean(sent?.version, scrubber, CLIENT_INFO_MAX_LEN);
  if (name !== undefined) info.name = name;
  if (version !== undefined) info.version = version;
  return Object.keys(info).length > 0 ? info : undefined;
}

function cleanHeaders(
  sent: Headers | null | undefined,
  scrubber: ObserveClientOptions["scrubber"],
): ClientObserved["headers"] {
  const headers: NonNullable<ClientObserved["headers"]> = {};
  for (const header of OBSERVED_HEADERS) {
    const value = clean(sent?.get(header), scrubber, HEADER_VALUE_MAX_LEN);
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

function assemble(
  info: ClientObserved["info"],
  headers: ClientObserved["headers"],
): ClientObserved | null {
  if (info === undefined && headers === undefined) return null;
  return { ...(info && { info }), ...(headers && { headers }) };
}

/** `null` when nothing was observed. */
export function observeClient(extra: Extra, options: ObserveClientOptions): ClientObserved | null {
  return assemble(
    orNothing(() => observedInfo(extra, options)),
    orNothing(() => cleanHeaders(extraHeaders(extra), options.scrubber)),
  );
}

/** Headers as a vendor's server framework holds them: a fetch `Headers`, or a
 * plain record such as Node's `req.headers`. */
export type HeaderInput = Headers | Record<string, string | readonly string[] | undefined>;

/** Only the registered names are copied in, so a header the platform refuses
 * to hold cannot cost the ones we read. */
function append(headers: Headers, name: string, value: string): void {
  try {
    headers.append(name, value);
  } catch {
    // A value Headers will not hold (a newline, a non-Latin-1 character) costs only itself.
  }
}

function registeredHeaders(input: HeaderInput): Headers {
  const out = new Headers();
  if (typeof (input as Headers).get === "function") {
    for (const name of OBSERVED_HEADERS) {
      const value: unknown = (input as Headers).get(name);
      if (typeof value === "string") append(out, name, value);
    }
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    if (!(OBSERVED_HEADERS as readonly string[]).includes(name)) continue;
    for (const line of typeof value === "string" ? [value] : Array.isArray(value) ? value : []) {
      if (typeof line === "string") append(out, name, line);
    }
  }
  return out;
}

/** The library path's `client_observed` (SPEC §5.6 rule 4): what the vendor's
 * code passed, under the same rules as what a client sends over MCP. */
export function clientObservedFrom(
  clientInfo: unknown,
  headers: HeaderInput | undefined,
  scrubber: ObserveClientOptions["scrubber"],
): ClientObserved | null {
  return assemble(
    orNothing(() => cleanInfo(declared(clientInfo), scrubber)),
    orNothing(() => (headers ? cleanHeaders(registeredHeaders(headers), scrubber) : undefined)),
  );
}
