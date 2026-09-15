/**
 * Coordinate coarsening for a request's `_meta` (handoff D5, 2026-09-15).
 *
 * ChatGPT sends `openai/userLocation` in `_meta` with latitude and longitude
 * at metre precision: two prod values resolved to a storefront and a home.
 * `roundMetaCoordinates` rounds them to 1 decimal (about 11 km) before the
 * meta becomes `runtime_meta`; the city, region, country and timezone beside
 * them stay.
 *
 * `_meta` only, on purpose. This is not a Scrubber rule: a vendor's own tool
 * that takes or returns coordinates keeps them at full precision in the
 * captured params and result. It runs BEFORE the vendor's scrubber, not
 * inside it, so a vendor who supplies their own scrubber still gets it.
 *
 * Mirrors the Python SDK's `round_meta_coordinates`; the two must store the
 * same value for the same client, which is why a tie is written the way
 * Python's `f"{x:.1f}"` writes it.
 */

import { DEPTH_LIMIT } from "./scrub.js";

// Case-insensitive exact match, like the Scrubber's REDACT_FIELD_NAMES, so
// `lat` / `lng` are not matched.
const COORD_FIELD_NAMES: ReadonlySet<string> = new Set(["latitude", "longitude"]);

// A string written as a plain decimal: sign, digits, optional fraction. Whole
// string, no trimming, no exponent, `Infinity` or `NaN`, the same grammar as
// the Python SDK's `_DECIMAL.fullmatch`. No `g` flag, so `.test()` is safe.
const DECIMAL_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** `{...}` literals and `Object.create(null)` only, as in `scrub.ts`: a
 * `Date` or class instance passes through rather than being rebuilt as a
 * bare object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** `value` to 1 decimal, written the way Python's `f"{value:.1f}"` writes
 * it. `toFixed` rounds from the exact binary value like Python does, with
 * one exception: an exact tie (a fraction of .25 or .75) goes away from
 * zero in `toFixed` and to the even digit in Python. `37.25` is `"37.2"`
 * in both SDKs only because of the branch below. */
function toOneDecimal(value: number): string {
  const magnitude = Math.abs(value);
  if (Number.isInteger(magnitude * 4) && !Number.isInteger(magnitude * 2)) {
    // Exact: x.25 * 10 is x2.5, x.75 * 10 is x7.5.
    const tenths = Math.floor(magnitude * 10);
    const even = tenths % 2 === 0 ? tenths : tenths + 1;
    return ((Math.sign(value) * even) / 10).toFixed(1);
  }
  return value.toFixed(1);
}

/** The rounded coordinate, keeping the value's type, or `undefined` when
 * the rule leaves `value` alone: an integer, `NaN`, `Infinity`, a boolean,
 * null, or a string that is not a decimal. A decimal string always comes
 * back with one decimal, so `"37"` becomes `"37.0"`. */
function roundCoordinate(value: unknown): number | string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && !Number.isInteger(value)
      ? Number(toOneDecimal(value))
      : undefined;
  }
  if (typeof value === "string" && DECIMAL_STRING.test(value)) {
    return toOneDecimal(Number(value));
  }
  return undefined;
}

function walk(value: unknown, depth: number): unknown {
  if (depth >= DEPTH_LIMIT) return value;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // The value sits at `depth + 1`, where the walk would stop, so the cap
      // applies to a coordinate the same as to anything else. The rule is
      // the key's own value only: a list under `latitude` is walked, not
      // rounded.
      const rounded =
        COORD_FIELD_NAMES.has(k.toLowerCase()) && depth + 1 < DEPTH_LIMIT
          ? roundCoordinate(v)
          : undefined;
      out[k] = rounded ?? walk(v, depth + 1);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1));
  }
  return value;
}

/**
 * A copy of `meta` with every `latitude` / `longitude` value rounded to 1
 * decimal in its own type, at any depth within DEPTH_LIMIT. Pure: `meta`
 * itself is not touched, so the handler and the runtime ladder still see
 * what the client sent.
 */
export function roundMetaCoordinates(meta: Record<string, unknown>): Record<string, unknown> {
  return walk(meta, 0) as Record<string, unknown>;
}
