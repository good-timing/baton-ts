/** The library API's session block and sequence numbers (SPEC §5.6). */

import * as asyncHooks from "node:async_hooks";
import {
  NO_CALLER,
  callerFor,
  wireLabels,
  type OrganizationWire,
  type PrincipalWire,
} from "../identity.js";
import {
  clientObservedFrom,
  type ClientObserved,
  type HeaderInput,
} from "../integrations/mcp/clientObserved.js";
import {
  CANDIDATE_HEADER,
  type CallSettings,
  type CaptureSettings,
  candidateId,
  TASK_HEADER,
  taskId,
} from "../integrations/mcp/captureSettings.js";
import { roundMetaCoordinates } from "../metaCoordinates.js";
import { scrubOrNull } from "../integrations/mcp/safeScrub.js";
import { uuid7 } from "../uuid7.js";
import { isRecord } from "../_object.js";
import { stripWhiteSpace } from "../_text.js";
import { printable, stderrLine } from "../warn.js";

const TRANSPORT_LIBRARY = "library";
const TURN_ID_META_KEY = "baton/turn_id";

/** What `client.session(...)` gives every call inside it. */
export interface LibrarySession {
  readonly sessionId: string;
  readonly origin: "observed" | "minted";
  readonly principal: PrincipalWire | null;
  readonly organization: OrganizationWire | null;
  readonly labels: readonly string[];
  readonly clientObserved: ClientObserved | null;
  readonly runtimeMeta: Record<string, unknown> | null;
  /** From the vendor's `headers`: a test change and its task. */
  readonly candidate: string | null;
  readonly task: string | null;
  /** The Console settings its calls run under; `undefined` means the client's own values. */
  readonly settings?: CallSettings;
}

export function sessionEnvelope(session: LibrarySession): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    session_id_origin: session.origin,
    transport_observed: TRANSPORT_LIBRARY,
    principal: session.principal,
    organization: session.organization,
    labels: wireLabels(session.labels),
    client_observed: session.clientObserved,
    runtime_meta: session.runtimeMeta,
    capture: session.settings?.capture ?? null,
  };
}

export interface SessionValues {
  sessionId?: string;
  principal?: unknown;
  clientInfo?: { name?: string; version?: string };
  headers?: HeaderInput;
  turnId?: string;
  meta?: unknown;
}

function warn(message: string): void {
  stderrLine(`baton: ${message}`);
}

function vendorId(name: string, value: unknown): string | null {
  const cleaned = typeof value === "string" ? stripWhiteSpace(value) : "";
  if (cleaned !== "") return cleaned;
  if (value !== undefined && value !== null) {
    warn(`${name} is not a non-blank string — ignoring it.`);
  }
  return null;
}

function blank(sessionId: string, origin: LibrarySession["origin"]): LibrarySession {
  return { sessionId, origin, ...NO_CALLER, clientObserved: null, runtimeMeta: null, candidate: null, task: null };
}

function requestMeta(meta: unknown): Record<string, unknown> | null {
  if (isRecord(meta)) return meta;
  if (meta !== undefined && meta !== null) warn("meta is not an object — ignoring it.");
  return null;
}

function runtimeMeta(
  meta: Record<string, unknown> | null,
  turnId: string | null,
  scrubber: (value: unknown) => unknown,
): Record<string, unknown> | null {
  // A client could send its own `baton/turn_id`; on a library event that key
  // is the vendor's (SPEC §11.4.1), so the client's copy never rides.
  const clientKeys = Object.fromEntries(Object.entries(meta ?? {}).filter(([key]) => key !== TURN_ID_META_KEY));
  const cleaned =
    Object.keys(clientKeys).length > 0 ? scrubOrNull(scrubber, roundMetaCoordinates(clientKeys), "_meta") : null;
  const out: Record<string, unknown> = isRecord(cleaned) ? { ...cleaned } : {};
  if (turnId !== null) out[TURN_ID_META_KEY] = turnId;
  return Object.keys(out).length > 0 ? out : null;
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
  const meta = requestMeta(values.meta);
  return {
    ...base,
    ...callerFor(values.principal, (_key, message) => warn(`principal ${message}`)),
    clientObserved: clientObservedFrom(values.clientInfo, values.headers, scrubber, meta),
    runtimeMeta: runtimeMeta(meta, vendorId("turnId", values.turnId), scrubber),
    candidate: vendorHeader(values.headers, CANDIDATE_HEADER, candidateId),
    task: vendorHeader(values.headers, TASK_HEADER, taskId),
  };
}

/** One header of the vendor's `headers`, which may keep the client's spelling of the name. */
function vendorHeader(
  headers: HeaderInput | undefined,
  name: string,
  parse: (value: unknown) => string | null,
): string | null {
  try {
    if (headers === undefined) return null;
    if (typeof (headers as Headers).get === "function") return parse((headers as Headers).get(name));
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key === undefined ? null : parse((headers as Record<string, unknown>)[key]);
  } catch {
    return null;
  }
}

// The owning client is stored with the block so one client's block never
// reaches another client's events.
const current = new asyncHooks.AsyncLocalStorage<{ owner: object; session: LibrarySession }>();

export function runInSession<T>(owner: object, session: LibrarySession, fn: () => T): T {
  return current.run({ owner, session }, fn);
}

let settingsWarned = false;

/** `owner`'s open block, or a minted session for this call alone, under the
 * settings in force now: a block can outlive a Console change. */
export function sessionForCall(owner: object, settings?: CaptureSettings): LibrarySession {
  const session = inBlock(owner) ? current.getStore()!.session : blank(uuid7(), "minted");
  if (settings === undefined) return session;
  try {
    const callSettings = settings.forCaller({
      labels: session.labels,
      clientName: session.clientObserved?.info?.name ?? null,
      shareKey: session.principal?.id ?? null,
      candidate: session.candidate,
      task: session.task,
    });
    return callSettings === undefined ? session : { ...session, settings: callSettings };
  } catch (err) {
    if (!settingsWarned) {
      settingsWarned = true;
      warn(`applying capture settings failed; this call uses the client's values: ${printable(err)}`);
    }
    return session;
  }
}

export function inBlock(owner: object): boolean {
  return current.getStore()?.owner === owner;
}

