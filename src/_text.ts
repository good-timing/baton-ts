/** String helpers shared by the capture paths.
 *
 * Small on purpose: this exists so the ONE rule below is written down once.
 */

/** Truncate to `max` CODE POINTS, never splitting a surrogate pair.
 *
 * ⚠ **Cut by code point, not by UTF-16 code unit, and the reason is a
 * downstream crash rather than tidiness.** Python's `value[:max]` counts code
 * points; `String.prototype.slice` counts units, so a value whose boundary
 * falls inside a surrogate pair ships a LONE SURROGATE. That survives
 * `JSON.stringify` (as a `\udXXX` escape) and `json.loads`, then raises
 * `UnicodeEncodeError` in the first Python consumer that re-encodes it — a
 * capture-side value breaking a reader far from here. Cutting by code point
 * also keeps the two SDKs agreeing on what "128 characters" means.
 *
 * Extracted from `runtimeAdapter.clean()`, which had it first and carried this
 * reasoning alone. `identity.userIdForPrincipal` then capped a raw `user_id`
 * with a plain `.slice()` and reintroduced exactly the defect — in a module
 * whose own `normalizePrincipal` REJECTS lone surrogates on the way in. One
 * home, so the next capped field inherits the rule instead of rediscovering
 * it.
 */
export function capCodePoints(value: string, max: number): string {
  // Fast path: `[...value]` allocates an array of every code point, and the
  // overwhelming majority of values are already under the cap.
  if (value.length <= max) return value;
  return [...value].slice(0, max).join("");
}
