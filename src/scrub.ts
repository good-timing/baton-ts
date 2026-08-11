/**
 * Source-side PII scrubbing for event payloads (SPEC §7).
 *
 * The SDK emits whatever the wrapped MCP server returns — including tool
 * params and results that may carry customer PII (emails in search results,
 * bearer tokens in error bodies, API keys pasted into chat tools). Persona
 * B's trust pitch is that nothing unscrubbed ever leaves the customer's
 * machine; this module is what makes that true. Every event payload runs
 * through `Scrubber` before it lands in the sink, so both local sinks AND
 * any HTTP sink see only scrubbed values.
 *
 * **Default ruleset** ships fixed for v1 (no public env-var configurability
 * — deferred until customer feedback justifies the surface area):
 *
 * - email — RFC-ish address regex
 * - bearer — `Bearer <opaque>` header values
 * - sk_key — OpenAI/Anthropic-style `sk-*` API keys
 * - aws_key — `AKIA*` access key IDs
 * - jwt — three-segment `eyJ*.*.*` tokens
 * - phone — North-American-leaning loose digit pattern
 * - cc — 13-19 digit candidates filtered by Luhn
 *
 * Plus field-name overrides: any object key matching
 * `{email, phone, ssn, api_key, token, secret, password, user_name}`
 * (case-insensitive) force-redacts its string value regardless of pattern.
 *
 * Differs from LangSmith's approach (off by default, bring-your-own regex)
 * by shipping rules on by default — the right tradeoff for Persona B's
 * consumer/SMB audience that won't write masking code.
 *
 * Ported from `baton` (Python)'s `src/baton/scrub.py` on 2026-08-11, which
 * is itself a parallel copy of baton-proxy's (the two are rule-identical —
 * verified by diff at port time; they differ only in docstrings). All three
 * ship parallel copies until the extracted shared package lands. Rule
 * parity here is verified by mirroring Python's `tests/test_scrub.py` test
 * matrix in `test/scrub.test.ts`; when a pattern lands or changes, port the
 * test every way.
 *
 * **Port notes** (where TypeScript forced a divergence from the Python):
 * - `counts` is a `Map<string, number>`, not a `collections.Counter`. Use
 *   `count(category)` for Python's zero-default read.
 * - Python walks anything `isinstance(dict)`; this walks only *plain*
 *   objects (`{}` / `Object.create(null)`). A `Date`, `Map`, or class
 *   instance passes through untouched rather than being flattened to `{}`
 *   — matching Python, where those aren't dicts either.
 */

/** Cap on recursive walk depth. Matches LangSmith's default; protects
 * against pathological inputs without truncating realistic MCP payloads. */
export const DEPTH_LIMIT = 10;

// Object keys whose string values are redacted regardless of value-pattern
// match. Case-insensitive exact match (no plural / prefix matching to keep
// false positives down). Kept narrow on purpose — too broad and we wreck
// legitimate fields like `Slack:channel_token_string_id`.
// `user_name` guards the PII half of a resolved end-user identity in the
// event it ever lands in a payload — defence in depth for the console path
// (residency contract). NOT `name`: that collides with legitimate payload
// keys (prompt names, tool names in surface snapshots).
const REDACT_FIELD_NAMES: ReadonlySet<string> = new Set([
  "email",
  "phone",
  "ssn",
  "api_key",
  "token",
  "secret",
  "password",
  "user_name",
]);

// Ordered list of [category, pattern]. Order matters where patterns can
// overlap: JWT must run before bearer because a bare JWT can look
// bearer-shaped. sk_key / aws_key run before email because their token
// bodies could otherwise match the email local-part regex.
//
// Every pattern carries `g`: Python's `re.sub` replaces ALL matches, while
// a JS regex without `g` replaces only the first. Safe as module-level
// constants because `String.prototype.replace` with a global regex resets
// `lastIndex` itself — never call `.test()` on these.
const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9_\-.+/=]{16,}/gi],
  ["sk_key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["aws_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  // Phone: optional `+1`, optional area-code parens, separators
  // `-` / `.` / space, 10 digits. Conservative — won't catch every
  // international format, but won't trip on every 10-digit identifier.
  ["phone", /\b(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g],
];

// Credit-card candidates — Luhn-filtered before redacting to keep false
// positives down on long numeric IDs (timestamps, order numbers).
const CC_CANDIDATE = /\b\d{13,19}\b/g;

/** Standard Luhn checksum. Caller passes a digits-only string of the right
 * length; we don't re-validate length here. */
function luhnValid(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

/** True only for `{...}` literals and `Object.create(null)` — the TS
 * analogue of Python's `isinstance(value, dict)`. Deliberately excludes
 * class instances, `Date`, `Map`, etc.: walking those would rebuild them as
 * bare objects and silently destroy the payload, whereas Python leaves them
 * alone because they aren't dicts. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Stateful recursive scrubber with the default ruleset baked in.
 *
 * Construct one per `withBaton` call and reuse for every event. The
 * `counts` map accumulates per-category redaction counts across all calls
 * so a downstream report can surface "N emails, M bearer tokens" at render
 * time. Nothing on the wire carries these today — they exist for parity
 * with Python and for vendor-side introspection.
 *
 * Instances are callable-compatible via the bound `scrub` method, so a
 * `Scrubber` plugs into anywhere the `(value: unknown) => unknown` slot
 * that `BatonConfig.scrubber` accepts expects a plain function.
 */
export class Scrubber {
  readonly counts = new Map<string, number>();

  /** Bound so `new Scrubber().scrub` can be passed as a bare function
   * reference — the closest TS gets to Python's `__call__`. */
  readonly scrub = (value: unknown): unknown => this.walk(value, 0, null);

  /** Python's `Counter[category]` zero-default read. */
  count(category: string): number {
    return this.counts.get(category) ?? 0;
  }

  private bump(category: string): void {
    this.counts.set(category, this.count(category) + 1);
  }

  private walk(value: unknown, depth: number, forceField: string | null): unknown {
    if (depth >= DEPTH_LIMIT) return value;
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        // A sensitive key's force-redaction propagates DOWN into nested
        // containers, not just its immediate string value — `{"password":
        // ["a", "b"]}` redacts both items.
        const nextForce = REDACT_FIELD_NAMES.has(k.toLowerCase()) ? k.toLowerCase() : forceField;
        out[k] = this.walk(v, depth + 1, nextForce);
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item, depth + 1, forceField));
    }
    if (typeof value === "string") {
      if (forceField !== null) {
        this.bump(`field:${forceField}`);
        return `[REDACTED:field-${forceField}]`;
      }
      return this.scrubString(value);
    }
    // number / boolean / null / undefined / Date / class instances — leave
    // alone. Sensitive data stored as a non-string at this leaf is rare in
    // MCP payloads and not worth the false-positive cost of stringifying
    // everything.
    return value;
  }

  private scrubString(s: string): string {
    let out = s;
    for (const [category, pattern] of PATTERNS) {
      out = out.replace(pattern, () => {
        this.bump(category);
        return `[REDACTED:${category}]`;
      });
    }
    // Credit card pass — separate because we Luhn-filter candidates before
    // counting / replacing. Skips non-CC long digit strings.
    return out.replace(CC_CANDIDATE, (match) => {
      if (!luhnValid(match)) return match;
      this.bump("cc");
      return "[REDACTED:cc]";
    });
  }
}

/**
 * No-op scrubber. Exported for explicit opt-out — vendors / customers who
 * legitimately want raw payloads pass this where `new Scrubber().scrub`
 * would otherwise be the default. Not the default: the SDK ships the same
 * default ruleset as `baton` (Python) and baton-proxy so untouched
 * integrations get PII scrubbing without the operator having to opt in.
 */
export function identityScrub(value: unknown): unknown {
  return value;
}
