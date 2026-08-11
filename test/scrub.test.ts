/**
 * Tests for the default scrubber (`src/scrub.ts`).
 *
 * Mirrors `baton` (Python)'s `tests/test_scrub.py` test matrix case-for-case
 * — which itself mirrors baton-proxy's — so the parallel copies stay
 * rule-equivalent until the extracted shared package lands. When a pattern
 * lands or changes, port the test every way.
 *
 * Coverage:
 *   - Each shipped pattern detects realistic positives and rejects common
 *     near-misses (digit-string IDs aren't phones, plain long numbers
 *     aren't credit cards).
 *   - Field-name override forces redaction regardless of value pattern,
 *     and propagates through nested containers under the sensitive key.
 *   - Recursive walk handles object / array nesting; non-string scalars
 *     pass through unchanged.
 *   - Depth limit aborts cleanly instead of recursing into pathological
 *     inputs.
 *   - Counts accumulate per category across multiple calls.
 *   - identityScrub is a no-op (explicit opt-out hook).
 *
 * Plus TS-only cases at the bottom for the two divergences the port forced
 * (global-flag replace-all, non-plain-object pass-through), which have no
 * Python counterpart to mirror.
 */

import { describe, expect, it } from "vitest";
import { DEPTH_LIMIT, Scrubber, identityScrub } from "../src/scrub.js";

// =============================================================================
// Pattern coverage
// =============================================================================

describe("pattern coverage", () => {
  it("redacts email", () => {
    const s = new Scrubber();
    const out = s.scrub("contact me at ujwal@goodtiming.ai please") as string;
    expect(out).not.toContain("ujwal@goodtiming.ai");
    expect(out).toContain("[REDACTED:email]");
    expect(s.count("email")).toBe(1);
  });

  it("redacts bearer token", () => {
    const s = new Scrubber();
    const out = s.scrub("Authorization: Bearer abc123XYZ_token-value+/=") as string;
    expect(out).not.toContain("abc123XYZ_token-value");
    expect(out).toContain("[REDACTED:bearer]");
    expect(s.count("bearer")).toBe(1);
  });

  it("redacts sk-style API key", () => {
    const s = new Scrubber();
    const out = s.scrub("api key sk-ABCDEFGHIJ1234567890klmnop here") as string;
    expect(out).not.toContain("sk-ABCDEFGHIJ1234567890klmnop");
    expect(out).toContain("[REDACTED:sk_key]");
    expect(s.count("sk_key")).toBe(1);
  });

  it("redacts AWS access key", () => {
    const s = new Scrubber();
    const out = s.scrub("AWS access key AKIAIOSFODNN7EXAMPLE leaked") as string;
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED:aws_key]");
    expect(s.count("aws_key")).toBe(1);
  });

  it("redacts JWT", () => {
    const s = new Scrubber();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk";
    const out = s.scrub(`token: ${jwt} end`) as string;
    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED:jwt]");
    expect(s.count("jwt")).toBe(1);
  });

  it("redacts phone number", () => {
    const s = new Scrubber();
    const out = s.scrub("call (555) 123-4567 anytime") as string;
    expect(out).not.toContain("(555) 123-4567");
    expect(out).toContain("[REDACTED:phone]");
    expect(s.count("phone")).toBe(1);
  });

  it("redacts a credit card with a valid Luhn checksum", () => {
    // Common test card number — passes Luhn.
    const s = new Scrubber();
    const out = s.scrub("card 4111111111111111 charged") as string;
    expect(out).not.toContain("4111111111111111");
    expect(out).toContain("[REDACTED:cc]");
    expect(s.count("cc")).toBe(1);
  });

  it("leaves a long digit string that fails Luhn alone", () => {
    // A 16-digit identifier that doesn't satisfy Luhn must pass through
    // unchanged — otherwise every long numeric ID (timestamps, order ids)
    // would look like a credit-card leak.
    const s = new Scrubber();
    const notACard = "1234567890123456"; // 16 digits, fails Luhn
    const out = s.scrub(`order id ${notACard}`) as string;
    expect(out).toContain(notACard);
    expect(s.count("cc")).toBe(0);
  });

  it("passes a plain string with no PII through untouched", () => {
    const s = new Scrubber();
    const out = s.scrub("the quick brown fox jumps over the lazy dog");
    expect(out).toBe("the quick brown fox jumps over the lazy dog");
    expect([...s.counts.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("counts each category when one string carries several", () => {
    const s = new Scrubber();
    const out = s.scrub("email a@b.co and phone 555-123-4567 leaked") as string;
    expect(out).toContain("[REDACTED:email]");
    expect(out).toContain("[REDACTED:phone]");
    expect(s.count("email")).toBe(1);
    expect(s.count("phone")).toBe(1);
  });
});

// =============================================================================
// Field-name override
// =============================================================================

describe("field-name override", () => {
  it("redacts the string value of a sensitive key", () => {
    const s = new Scrubber();
    expect(s.scrub({ password: "hunter2" })).toEqual({
      password: "[REDACTED:field-password]",
    });
    expect(s.count("field:password")).toBe(1);
  });

  it("matches the key case-insensitively", () => {
    const s = new Scrubber();
    const out = s.scrub({ Email: "ok@ok.co", TOKEN: "xyz" }) as Record<string, string>;
    expect(out.Email).toBe("[REDACTED:field-email]");
    expect(out.TOKEN).toBe("[REDACTED:field-token]");
    expect(s.count("field:email")).toBe(1);
    expect(s.count("field:token")).toBe(1);
  });

  it("propagates into nested arrays", () => {
    // `{"password": ["a", "b"]}` — both items redacted because the
    // sensitive field name flows down.
    const s = new Scrubber();
    expect(s.scrub({ password: ["one", "two"] })).toEqual({
      password: ["[REDACTED:field-password]", "[REDACTED:field-password]"],
    });
    expect(s.count("field:password")).toBe(2);
  });

  it("falls back to pattern matching on a non-sensitive key", () => {
    const s = new Scrubber();
    const out = s.scrub({ description: "reach me at hi@hi.co" }) as Record<string, string>;
    expect(out.description).not.toContain("hi@hi.co");
    expect(out.description).toContain("[REDACTED:email]");
    expect(s.count("email")).toBe(1);
  });
});

// =============================================================================
// Recursion + depth limit
// =============================================================================

describe("recursion and depth limit", () => {
  it("walks into nested objects", () => {
    const s = new Scrubber();
    const out = s.scrub({ a: { b: { c: "email me at x@y.co" } } }) as {
      a: { b: { c: string } };
    };
    expect(out.a.b.c).toContain("[REDACTED:email]");
  });

  it("walks into nested arrays", () => {
    const s = new Scrubber();
    const out = s.scrub([["x@y.co"], [{ z: "a@b.co" }]]) as [[string], [{ z: string }]];
    expect(out[0][0]).toContain("[REDACTED:email]");
    expect(out[1][0].z).toContain("[REDACTED:email]");
    expect(s.count("email")).toBe(2);
  });

  it("passes non-string scalars through", () => {
    const s = new Scrubber();
    const payload = { n: 42, b: true, x: null, f: 3.14 };
    expect(s.scrub(payload)).toEqual(payload);
  });

  it("does not crash on input deeper than the cap", () => {
    // Construct a structure deeper than DEPTH_LIMIT — should return
    // cleanly without scrubbing past the cap. Just verifying no recursion
    // blow-up and a sane result; the deep leaf may or may not be scrubbed
    // depending on exactly where the cap hits.
    const s = new Scrubber();
    const deep: Record<string, unknown> = { a: "x@y.co" };
    let cur = deep;
    for (let i = 0; i < DEPTH_LIMIT + 5; i += 1) {
      cur.next = { a: "x@y.co" };
      cur = cur.next as Record<string, unknown>;
    }
    const out = s.scrub(deep);
    expect(typeof out).toBe("object");
    expect(out).not.toBeNull();
  });

  it("returns the value untouched at the depth cap rather than dropping it", () => {
    // Python returns `value` unchanged at `depth >= DEPTH_LIMIT` — it
    // neither redacts nor drops. A port that returned null/undefined there
    // would silently truncate deep payloads.
    const s = new Scrubber();
    let leaf: unknown = "a@b.co";
    for (let i = 0; i < DEPTH_LIMIT; i += 1) leaf = { nest: leaf };
    const out = s.scrub(leaf);
    expect(JSON.stringify(out)).toContain("a@b.co");
    expect(s.count("email")).toBe(0);
  });
});

// =============================================================================
// Counter behavior + idempotency
// =============================================================================

describe("counts and idempotency", () => {
  it("accumulates across calls", () => {
    const s = new Scrubber();
    s.scrub("a@b.co");
    s.scrub({ more: "c@d.co" });
    s.scrub({ password: "p", email: "e@e.co" });
    expect(s.count("email")).toBe(2);
    expect(s.count("field:password")).toBe(1);
    expect(s.count("field:email")).toBe(1);
  });

  it("is idempotent on an already-scrubbed string", () => {
    // Scrubbing an already-scrubbed string is a no-op — the redaction
    // token itself contains no pattern matches.
    const s = new Scrubber();
    const once = s.scrub("email a@b.co");
    const twice = s.scrub(once);
    expect(twice).toBe(once);
    expect(s.count("email")).toBe(1); // second pass didn't double-count
  });
});

// =============================================================================
// identityScrub (explicit opt-out hook)
// =============================================================================

describe("identityScrub", () => {
  it("returns the input unchanged, by reference", () => {
    const payload = { email: "x@y.co", nested: ["a@b.co"] };
    expect(identityScrub(payload)).toBe(payload);
  });

  it("has no state to accumulate", () => {
    // identityScrub is a plain function. Tests relying on counts must use
    // Scrubber explicitly.
    expect(identityScrub("email a@b.co")).toBe("email a@b.co");
  });
});

// =============================================================================
// TS-specific divergences (no Python counterpart)
// =============================================================================

describe("TypeScript port specifics", () => {
  it("replaces EVERY match in a string, not just the first", () => {
    // Python's `re.sub` is replace-all; a JS regex without the `g` flag
    // replaces only the first match. This is the single likeliest way the
    // port silently under-redacts, so it gets its own test.
    const s = new Scrubber();
    const out = s.scrub("a@b.co, c@d.co, e@f.co") as string;
    expect(out).toBe("[REDACTED:email], [REDACTED:email], [REDACTED:email]");
    expect(s.count("email")).toBe(3);
  });

  it("does not re-enter a global regex mid-string across calls", () => {
    // Guards the `lastIndex` footgun: module-level `g` regexes are shared
    // across every Scrubber instance and every call. `String.replace`
    // resets `lastIndex`, but a future refactor to `.test()`/`.exec()`
    // would not — this test fails loudly if that lands.
    const a = new Scrubber();
    const b = new Scrubber();
    expect(a.scrub("x@y.co")).toBe("[REDACTED:email]");
    expect(b.scrub("x@y.co")).toBe("[REDACTED:email]");
    expect(a.scrub("x@y.co")).toBe("[REDACTED:email]");
  });

  it("leaves non-plain objects intact instead of flattening them to {}", () => {
    // Python walks `isinstance(value, dict)` only, so a datetime passes
    // through. The TS analogue must exclude Date/Map/class instances —
    // walking them would rebuild them as bare objects and destroy the
    // payload.
    const s = new Scrubber();
    const date = new Date(0);
    const map = new Map([["email", "x@y.co"]]);
    class Custom {
      note = "a@b.co";
    }
    const custom = new Custom();
    const out = s.scrub({ date, map, custom }) as Record<string, unknown>;
    expect(out.date).toBe(date);
    expect(out.map).toBe(map);
    expect(out.custom).toBe(custom);
  });

  it("walks an object created with a null prototype", () => {
    const s = new Scrubber();
    const bare = Object.create(null) as Record<string, unknown>;
    bare.note = "a@b.co";
    const out = s.scrub(bare) as Record<string, string>;
    expect(out.note).toContain("[REDACTED:email]");
  });
});
