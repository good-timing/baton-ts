/** The library API's session block and sequence numbers (SPEC §5.6). */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  NO_CALLER,
  callerFor,
  pythonStrip,
  type OrganizationWire,
  type PrincipalWire,
} from "../identity.js";
import {
  clientObservedFrom,
  type ClientObserved,
  type HeaderInput,
} from "../integrations/mcp/clientObserved.js";
import { uuid7 } from "../uuid7.js";

const TRANSPORT_LIBRARY = "library";
const TURN_ID_META_KEY = "baton/turn_id";

/** What `client.session(...)` gives every call inside it. */
export interface LibrarySession {
  readonly sessionId: string;
  readonly origin: "observed" | "minted";
  readonly principal: PrincipalWire | null;
  readonly organization: OrganizationWire | null;
  readonly clientObserved: ClientObserved | null;
  readonly turnId: string | null;
}

export function sessionEnvelope(session: LibrarySession): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    session_id_origin: session.origin,
    transport_observed: TRANSPORT_LIBRARY,
    principal: session.principal,
    organization: session.organization,
    client_observed: session.clientObserved,
    runtime_meta: session.turnId !== null ? { [TURN_ID_META_KEY]: session.turnId } : null,
  };
}

export interface SessionValues {
  sessionId?: string;
  principal?: unknown;
  clientInfo?: { name?: string; version?: string };
  headers?: HeaderInput;
  turnId?: string;
}

function warn(message: string): void {
  process.stderr.write(`baton: ${message}\n`);
}

function vendorId(name: string, value: unknown): string | null {
  const cleaned = typeof value === "string" ? pythonStrip(value) : "";
  if (cleaned !== "") return cleaned;
  if (value !== undefined && value !== null) {
    warn(`${name} is not a non-blank string — ignoring it.`);
  }
  return null;
}

function blank(sessionId: string, origin: LibrarySession["origin"]): LibrarySession {
  return { sessionId, origin, ...NO_CALLER, clientObserved: null, turnId: null };
}

/** A `session()` block's values. A value that is not usable is logged and dropped. */
export function newSession(
  values: SessionValues,
  scrubber: (value: unknown) => unknown,
  disabled: boolean,
): LibrarySession {
  const id = vendorId("sessionId", values.sessionId);
  const base = id !== null ? blank(id, "observed") : blank(uuid7(), "minted");
  // Off stops the work too: no scrubber runs on a value that is never sent.
  if (disabled) return base;
  return {
    ...base,
    ...callerFor(values.principal, (_key, message) => warn(`principal ${message}`)),
    clientObserved: clientObservedFrom(values.clientInfo, values.headers, scrubber),
    turnId: vendorId("turnId", values.turnId),
  };
}

// The owning client is stored with the block so one client's block never
// reaches another client's events.
const current = new AsyncLocalStorage<{ owner: object; session: LibrarySession }>();

export function runInSession<T>(owner: object, session: LibrarySession, fn: () => T): T {
  return current.run({ owner, session }, fn);
}

/** `owner`'s open block, or a minted session for this call alone. */
export function sessionForCall(owner: object): LibrarySession {
  const entry = current.getStore();
  return entry !== undefined && entry.owner === owner ? entry.session : blank(uuid7(), "minted");
}

