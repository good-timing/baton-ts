/** String helpers shared by the capture and log paths. */

// Unicode `White_Space`, exactly (SPEC §11.4's blank rule). Not `.trim()`, which
// also removes U+FEFF and keeps U+0085, nor `str.strip()`, which also removes U+001C-U+001F.
const WHITE_SPACE = /^\p{White_Space}$/u;
const ALL_WHITE_SPACE = /^\p{White_Space}*$/u;

/** `value` without leading and trailing characters matching `space`, a
 * one-character pattern. A scan, not `/^x+|x+$/`, which is quadratic on a long
 * run of spaces inside the string. */
export function stripEdges(value: string, space: RegExp): string {
  let start = 0;
  let end = value.length;
  while (start < end && space.test(value[start]!)) start++;
  while (end > start && space.test(value[end - 1]!)) end--;
  return value.slice(start, end);
}

export function stripWhiteSpace(value: string): string {
  return stripEdges(value, WHITE_SPACE);
}

export function isBlank(value: string): boolean {
  return ALL_WHITE_SPACE.test(value);
}

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
 */
/** Whether `value` is longer than `max` CODE POINTS — the check form of
 * `capCodePoints`, for a field that is dropped rather than cut. */
export function exceedsCodePoints(value: string, max: number): boolean {
  // Each code point is one or two UTF-16 units, so the unit count brackets it.
  if (value.length <= max) return false;
  if (value.length > 2 * max) return true;
  return [...value].length > max;
}

export function capCodePoints(value: string, max: number): string {
  // Fast path: `[...value]` allocates an array of every code point, and the
  // overwhelming majority of values are already under the cap.
  if (value.length <= max) return value;
  return [...value].slice(0, max).join("");
}

/** Backslashes and control, format and separator characters as `\u{hex}`, so
 * text from outside cannot break or recolour a log line, or pass for an escape. */
export function escapeForLog(value: string): string {
  return value.replace(/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}
