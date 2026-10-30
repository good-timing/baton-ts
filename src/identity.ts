/** Principal identity — what a vendor's resolver hands back, and how it goes
 * on the wire.
 *
 * The TypeScript half of Python's `baton/identity.py`. Baton attaches the
 * resolved principal to every event so the Console can group by
 * `(tenant_id, vendor_id, principal.id)`, at whatever grain the vendor
 * resolved (SPEC §11.4). The resolver decides everything about the value: who
 * it names, whether it is hashed, what a page shows for it. The SDK sends it
 * on as stated.
 */

import { capCodePoints, exceedsCodePoints } from "./_text.js";

/** Where a principal came from. `"asserted"` is a vendor's own resolver,
 * which nothing in the protocol checks, and is the only value this SDK
 * emits — `integrations/mcp/principalResolution.ts` has the why, and the
 * wording trap that comes with it. */
export const PRINCIPAL_SOURCE_ASSERTED = "asserted";

/** What the emitted value IS — the privacy classification, and the only thing
 * SPEC §11.4 lets a consumer classify on. */
export const PRINCIPAL_FORM_HASHED = "hashed";
export const PRINCIPAL_FORM_RAW = "raw";

/** Cap on `principal.id`, in code points: it is vendor-supplied text copied
 * onto every event of a call. Mirrors Python's `PRINCIPAL_ID_MAX_LEN`. */
export const PRINCIPAL_ID_MAX_LEN = 128;

/** Cap on `displayName`, in CODE POINTS (Python's `len`). Over it the name is
 * DROPPED, not truncated: SPEC §11.4 forbids rewriting it, so both SDKs send
 * the same bytes for one resolver output. */
export const DISPLAY_NAME_MAX_LEN = 128;

// Unicode `White_Space`, exactly (SPEC §11.4's blank rule). Not `.trim()`:
// that also removes U+FEFF and keeps U+0085, which Python's `strip()` does the
// other way round, so the two SDKs would disagree on what is blank.
const ALL_WHITE_SPACE = /^\p{White_Space}*$/u;

/** The resolver's `displayName` as it goes on the wire, or `null`. Verbatim
 * when usable. A non-string, a blank (only Unicode `White_Space`), an
 * over-long value or one holding a lone surrogate or U+0000 is dropped ALONE — the rest
 * of the principal still ships, because a bad label is no reason to lose a
 * good id. Mirrors Python's `wire_display_name`. */
export function wireDisplayName(value: unknown): string | null {
  if (typeof value !== "string" || exceedsCodePoints(value, DISPLAY_NAME_MAX_LEN)) return null;
  // U+0000: Postgres text refuses it, costing a collector the whole event.
  if (LONE_SURROGATE.test(value) || value.includes("\u0000") || ALL_WHITE_SPACE.test(value)) return null;
  return value;
}

export type PrincipalForm = typeof PRINCIPAL_FORM_HASHED | typeof PRINCIPAL_FORM_RAW;

const PRINCIPAL_FORMS: ReadonlySet<unknown> = new Set([PRINCIPAL_FORM_RAW, PRINCIPAL_FORM_HASHED]);

/** Codepoints Python's `str.strip()` removes, measured against CPython rather
 * than assumed — `\s` in JavaScript is the WRONG set in BOTH directions.
 *
 * JS `\s` omits `\x1c`-`\x1f` and `\x85`, which Python strips; and JS `\s`
 * INCLUDES `U+FEFF`, which Python does not, so `.trim()` is never correct
 * where the two SDKs must agree on what is blank. */
const PYTHON_WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_STRIP = new RegExp(`^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`, "gu");

/** Matches a string containing an UNPAIRED surrogate.
 *
 * `String.prototype.isWellFormed()` says the same thing more plainly, but it
 * needs `lib: ES2024` and this package declares `ES2022` — a lib bump is a
 * statement about what every consumer must support, which is too broad a
 * change to make for one predicate. Under the `u` flag a valid pair is a
 * single code point and does NOT match, while a lone half does; verified to
 * agree with `isWellFormed()` on both. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Python's `str.strip()`, over exactly the set above. Exported for the
 * server-name rule in `integrations/mcp/annotationName.ts`, which has to agree
 * with Python's on what counts as a blank name. */
export function pythonStrip(value: string): string {
  return value.replace(PYTHON_STRIP, "");
}

/** A principal as a vendor's resolver produced it. */
export interface Principal {
  /** A stable identifier from the vendor's own system. Never an application
   * id: that names the app and is identical for every one of its users, which
   * merges them into one actor. */
  principalId: string;
  /** What `principalId` is: `"raw"`, a real identity, or `"hashed"`, a
   * pseudonym the resolver derived itself. A consumer treats anything not
   * `"hashed"` as personal data, so leave it unset unless the resolver hashed
   * the value. */
  form?: PrincipalForm | undefined;
  /** What a page shows for this principal — `principalFromOAuthEmail` puts
   * the part of the address before the last `@` here. Sent verbatim and never
   * through the scrubber (SPEC §11.4): the vendor chooses what is safe to
   * show, and it is personal data whatever `form` says. An unusable value is
   * dropped alone — see `wireDisplayName`. */
  displayName?: string | null | undefined;
  /** The company this principal belongs to. Sent as `organization`, and
   * dropped alone when unusable (SPEC §11.4). */
  organization?: Organization | null | undefined;
}

/** The company or workspace the caller belongs to, as the vendor sees it.
 * Sent as `organization` (SPEC §11.4), beside `principal` or alone. It is
 * never counted as a person. `form` describes `organizationId` alone. */
export interface Organization {
  organizationId: string;
  form?: PrincipalForm | undefined;
  displayName?: string | null | undefined;
}

function usableId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  // A lone surrogate cannot be UTF-8 encoded: the sink would send U+FFFD in
  // its place, so `"a\uD800"` and `"a\uDC00"` would arrive as one actor.
  if (LONE_SURROGATE.test(id)) return false;
  // U+0000 is refused by Postgres text and would cost a collector the whole event.
  if (id.includes("\u0000")) return false;
  // A blank id names nobody, and every such caller would merge into one actor.
  return pythonStrip(id) !== "";
}

function readIdentity(
  result: unknown,
  idKey: "principalId" | "organizationId",
): { id: string; form: unknown; displayName: string | undefined } | null {
  if (result === null || typeof result !== "object") return null;
  const candidate = result as Record<string, unknown>;
  const id = candidate[idKey];
  if (!usableId(id)) return null;
  // Shape only; the name's own rules run once, in `identityWire`.
  const displayName = typeof candidate.displayName === "string" ? candidate.displayName : undefined;
  return { id, form: candidate.form, displayName };
}

/** The principal AS EMITTED — the finished envelope value (SPEC §11.4).
 *
 * Not `Principal`: that one is what a vendor's `resolvePrincipal` hook HANDS
 * US, this one is what we PUT ON THE WIRE — the same value, with `source`
 * added.
 *
 * **`id`, `source` and `form` are REQUIRED.** A producer emits the whole
 * thing or omits `principal` entirely; a partial object is malformed, not a
 * degraded reading. So there is no conformant event carrying an `id` whose
 * `form` a consumer has to guess.
 */
export interface PrincipalWire {
  /** The value, as the vendor's resolver returned it: a real identity, or a
   * pseudonym the resolver derived. Which one is `form`, and it is NEVER the
   * value's shape — a real OIDC subject (`mailto:`, `acct:`, `urn:`,
   * `https:`) reads as a scheme-tagged pseudonym to anything testing for
   * "letters then a colon". */
  id: string;
  /** WHERE it came from. Always `"asserted"` here — `principalResolution.ts`
   * has the why and the wording trap. */
  source: typeof PRINCIPAL_SOURCE_ASSERTED;
  /** WHAT it is. */
  form: PrincipalForm;
  /** What a page shows; personal data whenever present, whatever `form`
   * says. OMITTED, never `null`, when there is none — so a nameless principal
   * is byte-identical to one from before the member existed. */
  display_name?: string;
}

/** The organization as emitted: `principal`'s members and rules, with its
 * own `form` (SPEC §11.4). */
export type OrganizationWire = PrincipalWire;

// ⚠ **Literal types here, `z.string()` on `PrincipalWireSchema` — and the
// asymmetry is deliberate.** That schema is the PARSE boundary and must
// tolerate a value SPEC registers later; this is the PRODUCER type, and this
// SDK emits exactly one `source` and two `form`s. Widening it would inherit
// the schema's justification without its reason, and would let a stray
// string through. Typed this way, adding a source is a compile error in one
// place — here, where the registry is.

/** The envelope's `principal` and `organization`. Either, both or neither
 * may be set: SPEC §11.4 keeps them independent. */
export interface CallerWire {
  principal: PrincipalWire | null;
  organization: OrganizationWire | null;
}

export const NO_CALLER: CallerWire = Object.freeze({ principal: null, organization: null });

/** Told why `callerFor` dropped or rewrote something. `key` is fixed text, so
 * a caller can report each kind of problem once; `message` may hold part of
 * the vendor's value. */
export type CallerWarning = (key: string, message: string) => void;

/** What a `resolvePrincipal` hook returned, or `principal` was given, as wire
 * objects: a `Principal`, which may carry its `organization`, or an
 * `Organization` alone. Each is dropped alone when unusable. Never throws:
 * the value is vendor code, and a getter or Proxy on it may. */
export function callerFor(result: unknown, warn: CallerWarning): CallerWire {
  try {
    return readCaller(result, warn);
  } catch {
    warn("unreadable", "could not be read — sending neither principal nor organization.");
    return NO_CALLER;
  }
}

function readCaller(result: unknown, warn: CallerWarning): CallerWire {
  if (result === undefined || result === null) return NO_CALLER;
  if (typeof result !== "object") {
    warn("not-object", `got a ${typeof result}, not an object — sending neither principal nor organization.`);
    return NO_CALLER;
  }
  // A `principalId` or an `organization` key makes it a `Principal`, so a
  // missing or blank person still keeps the company; otherwise an `Organization`.
  if (!("principalId" in result) && !("organization" in result)) {
    if ("organizationId" in result) {
      return { principal: null, organization: identityFor(result, "organization", warn) };
    }
    if (typeof (result as { userId?: unknown }).userId === "string") {
      warn(
        "user-id",
        "returned { userId }, which was renamed to { principalId } in 0.3.5, so the principal " +
          "is dropped from every event until it returns the new key.",
      );
    } else {
      warn("no-id", "got an object with neither principalId nor organizationId — sending neither.");
    }
    return NO_CALLER;
  }
  if ("organizationId" in result) {
    warn("flat-organization-id", "got principalId and organizationId side by side; put the company in `organization`.");
  }
  const nested = (result as { organization?: unknown }).organization;
  return {
    principal: identityFor(result, "principal", warn),
    organization: nested == null ? null : identityFor(nested, "organization", warn),
  };
}

function identityFor(
  value: unknown,
  member: "principal" | "organization",
  warn: CallerWarning,
): PrincipalWire | null {
  const idKey = member === "principal" ? "principalId" : "organizationId";
  const identity = readIdentity(value, idKey);
  if (identity === null) {
    warn(`${member}:id`, `${member} has no usable ${idKey} — sending no ${member}.`);
    return null;
  }
  return identityWire(identity.id, identity.form, identity.displayName, (form) =>
    warn(`${member}:form`, `${member} form ${describeForm(form)} is not registered — sending "raw".`),
  );
}

function describeForm(form: unknown): string {
  return typeof form === "string" ? JSON.stringify(form.slice(0, 32)) : `of type ${typeof form}`;
}

/** The id is sent as given: not scrubbed, since a scrubber that redacts emails
 * would map every user onto one redaction constant and merge them into one. */
function identityWire(
  id: string,
  stated: unknown,
  displayName: unknown,
  onUnregisteredForm?: (form: unknown) => void,
): PrincipalWire {
  let form: PrincipalForm = PRINCIPAL_FORM_RAW;
  if (stated !== undefined) {
    if (PRINCIPAL_FORMS.has(stated)) {
      form = stated as PrincipalForm;
    } else {
      // SPEC §11.4: anything not "hashed" is personal data, so that is the
      // only safe reading of a form nobody registered.
      onUnregisteredForm?.(stated);
    }
  }
  const wire: PrincipalWire = {
    // `capCodePoints`, not `.slice()`: a plain slice counts UTF-16 units, so
    // an astral id cut at the boundary would ship a lone surrogate.
    id: capCodePoints(id, PRINCIPAL_ID_MAX_LEN),
    source: PRINCIPAL_SOURCE_ASSERTED,
    form,
  };
  const name = wireDisplayName(displayName);
  if (name !== null) wire.display_name = name;
  return wire;
}
