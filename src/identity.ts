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
}

/** What `normalizePrincipal` hands on: the resolver's `form` is still
 * unchecked, because only `principalFor` has a channel to warn on. */
export type ResolvedPrincipal = Omit<Principal, "form"> & { form?: unknown };

/** Normalize whatever a vendor's hook returned into a usable principal, or
 * `null` if it gave us nothing usable.
 *
 * TypeScript types vanish at runtime and a hook is vendor code, so a plain
 * string or a half-built object is a MISS, never a partially-built principal.
 */
export function normalizePrincipal(result: unknown): ResolvedPrincipal | null {
  if (result === null || typeof result !== "object") return null;
  const candidate = result as { principalId?: unknown; form?: unknown; displayName?: unknown };
  if (typeof candidate.principalId !== "string") return null;
  // A lone surrogate cannot be UTF-8 encoded: the sink would send U+FFFD in
  // its place, so `"a\uD800"` and `"a\uDC00"` would arrive as one actor.
  if (LONE_SURROGATE.test(candidate.principalId)) return null;
  // U+0000 is refused by Postgres text and would cost a collector the whole event.
  if (candidate.principalId.includes("\u0000")) return null;
  // A blank id names nobody, and every such caller would merge into one actor.
  if (pythonStrip(candidate.principalId) === "") return null;
  const principal: ResolvedPrincipal = { principalId: candidate.principalId };
  if (candidate.form !== undefined) principal.form = candidate.form;
  // Shape only; the name's own rules run once, in `principalFor`.
  if (typeof candidate.displayName === "string") principal.displayName = candidate.displayName;
  return principal;
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

// ⚠ **Literal types here, `z.string()` on `PrincipalWireSchema` — and the
// asymmetry is deliberate.** That schema is the PARSE boundary and must
// tolerate a value SPEC registers later; this is the PRODUCER type, and this
// SDK emits exactly one `source` and two `form`s. Widening it would inherit
// the schema's justification without its reason, and would let a stray
// string through. Typed this way, adding a source is a compile error in one
// place — here, where the registry is.

/** The resolver's principal as the wire object.
 *
 * The id is sent as given: not scrubbed, since a scrubber that redacts emails
 * would map every user onto one redaction constant and merge them into a
 * single actor.
 */
export function principalFor(
  principal: ResolvedPrincipal,
  onUnregisteredForm?: (form: unknown) => void,
): PrincipalWire {
  let form: PrincipalForm = PRINCIPAL_FORM_RAW;
  if (principal.form !== undefined) {
    if (PRINCIPAL_FORMS.has(principal.form)) {
      form = principal.form as PrincipalForm;
    } else {
      // SPEC §11.4: anything not "hashed" is personal data, so that is the
      // only safe reading of a form nobody registered.
      onUnregisteredForm?.(principal.form);
    }
  }
  const wire: PrincipalWire = {
    // `capCodePoints`, not `.slice()`: a plain slice counts UTF-16 units, so
    // an astral id cut at the boundary would ship a lone surrogate.
    id: capCodePoints(principal.principalId, PRINCIPAL_ID_MAX_LEN),
    source: PRINCIPAL_SOURCE_ASSERTED,
    form,
  };
  const displayName = wireDisplayName(principal.displayName);
  if (displayName !== null) wire.display_name = displayName;
  return wire;
}
