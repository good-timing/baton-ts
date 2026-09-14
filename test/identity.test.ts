import { describe, expect, it } from "vitest";

import {
  HASH_SCHEME,
  RAW_USER_ID_MAX_LEN,
  VENDOR_HASH_SCHEME,
  hashUserId,
  normalizePrincipal,
  userIdForPrincipal,
} from "../src/identity.js";
import vectors from "./identityVectors.json" with { type: "json" };

/** The differential corpus. Every `expected` here was produced by Python's
 * `baton.identity.hash_user_id` and written by `scripts/gen_identity_vectors.py`
 * — nothing in this file is hand-derived, which is the whole point. A hand
 * -written expectation only proves this implementation agrees with whoever
 * wrote the test; these prove it agrees with the other SDK.
 *
 * ⚠ This METHOD is new. `scrub.ts` parity mirrors Python's test matrix
 * case-for-case by hand; nothing there is generated. A generated corpus is the
 * stronger form, and the reason is the same one: a person reaching two SDKs
 * must be ONE actor downstream. */
describe("hashUserId parity with the Python SDK", () => {
  for (const c of vectors.cases) {
    it(`matches Python: ${c.name}`, () => {
      expect(
        hashUserId(c.principal, {
          tenantId: vectors.tenant_id,
          key: vectors.key_utf8,
          issuer: c.issuer,
          scheme: c.scheme,
        }),
      ).toBe(c.expected);
    });
  }

  it("covers the canonicalization traps on purpose", () => {
    // A guard on the corpus itself: these vectors are the reason the
    // canonicalizer cannot use `.trim()`, so losing them silently would let a
    // `.trim()` regression pass the rest of the suite.
    const names = vectors.cases.map((c) => c.name);
    expect(names.some((n) => n.includes("BOM"))).toBe(true);
    expect(names.some((n) => n.includes("NFD"))).toBe(true);
    expect(names.some((n) => n.includes("WHITESPACE-ONLY"))).toBe(true);
  });
});

describe("hashUserId properties", () => {
  const KEY = "unit-key";

  it("tags the derivation without moving the digest", () => {
    // Documented and load-bearing: the same person reached by two provenances
    // is recognisably the same hex under two tags, so a consumer that wants to
    // unify them downstream can, and one that must keep them apart still can.
    const attested = hashUserId("e-1", { tenantId: "t", key: KEY, scheme: HASH_SCHEME });
    const asserted = hashUserId("e-1", { tenantId: "t", key: KEY, scheme: VENDOR_HASH_SCHEME });

    expect(attested).not.toBe(asserted);
    expect(attested.split(":")[1]).toBe(asserted.split(":")[1]);
  });

  it("folds the tenant into the MESSAGE, so one principal cannot correlate across tenants", () => {
    expect(hashUserId("e-1", { tenantId: "t-a", key: KEY, scheme: HASH_SCHEME })).not.toBe(
      hashUserId("e-1", { tenantId: "t-b", key: KEY, scheme: HASH_SCHEME }),
    );
  });

  it("treats a missing issuer as the pre-issuer form", () => {
    // The append-only layout: every hash the proxy and extmcp have emitted
    // since 0.5.0 was issuer-less, and they share this contract.
    const omitted = hashUserId("e-1", { tenantId: "t", key: KEY, scheme: HASH_SCHEME });
    expect(hashUserId("e-1", { tenantId: "t", key: KEY, issuer: null, scheme: HASH_SCHEME })).toBe(omitted);
    expect(hashUserId("e-1", { tenantId: "t", key: KEY, issuer: undefined, scheme: HASH_SCHEME })).toBe(omitted);
  });

  it("separates two people who share a subject under different issuers", () => {
    expect(hashUserId("sub-7", { tenantId: "t", key: KEY, issuer: "https://a.example", scheme: HASH_SCHEME })).not.toBe(
      hashUserId("sub-7", { tenantId: "t", key: KEY, issuer: "https://b.example", scheme: HASH_SCHEME }),
    );
  });

  it("encodes a string key as UTF-8, matching Python's env-var path", () => {
    expect(hashUserId("e-1", { tenantId: "t", key: "🔑", scheme: HASH_SCHEME })).toBe(
      hashUserId("e-1", { tenantId: "t", key: new TextEncoder().encode("🔑"), scheme: HASH_SCHEME }),
    );
  });
});

describe("normalizePrincipal", () => {
  it("accepts a well-formed principal", () => {
    expect(normalizePrincipal({ userId: "e-1", issuer: "https://idp" })).toEqual({
      userId: "e-1",
      issuer: "https://idp",
    });
  });

  it("rejects an empty or whitespace-only userId", () => {
    // The measured divergence from AgentCat, whose falsy-only guard lets
    // `{userId: ""}` reach their wire. An empty principal hashes to one stable
    // digest naming nobody, merging every such caller into one phantom actor.
    expect(normalizePrincipal({ userId: "" })).toBeNull();
    expect(normalizePrincipal({ userId: "   " })).toBeNull();
    expect(normalizePrincipal({ userId: " " })).toBeNull();
  });

  it("rejects a lone surrogate, which would otherwise MERGE distinct people", () => {
    // Node's `update(…, "utf8")` does not throw on an unpaired surrogate — it
    // substitutes U+FFFD — so these three principals all hash to ONE digest
    // (measured). That is the actor merge this module exists to prevent,
    // through the quietest door available. Python raises `UnicodeEncodeError`
    // and drops the field, so refusing here also keeps the two arms agreeing:
    // same input, same answer.
    const HIGH = String.fromCharCode(0xd800);
    const LOW = String.fromCharCode(0xdc00);
    expect(normalizePrincipal({ userId: `a${HIGH}` })).toBeNull();
    expect(normalizePrincipal({ userId: `a${LOW}` })).toBeNull();
    // A well-formed pair is NOT a lone surrogate and must still resolve —
    // otherwise the guard eats every emoji-bearing subject.
    expect(normalizePrincipal({ userId: "a😀" })).toEqual({ userId: "a😀", issuer: null });
  });

  it("drops a malformed ISSUER but keeps the identity", () => {
    const HIGH = String.fromCharCode(0xd800);
    expect(normalizePrincipal({ userId: "e-1", issuer: `https://idp${HIGH}` })).toEqual({
      userId: "e-1",
      issuer: null,
    });
  });

  it("treats anything that is not a principal-shaped object as a miss", () => {
    // Types vanish at runtime and a hook is vendor code; the prior art returns
    // a bare object, so these are the shapes that actually arrive.
    for (const junk of [null, undefined, "e-1", 42, [], { user_id: "e-1" }, { userId: 7 }]) {
      expect(normalizePrincipal(junk)).toBeNull();
    }
  });

  it("drops a non-string or empty issuer rather than losing the whole principal", () => {
    // A junk issuer costs the ISSUER, not the identity — the subject still
    // resolves, which is the difference between a degraded actor and no actor.
    expect(normalizePrincipal({ userId: "e-1", issuer: 7 })).toEqual({
      userId: "e-1",
      issuer: null,
    });
    expect(normalizePrincipal({ userId: "e-1", issuer: "" })).toEqual({
      userId: "e-1",
      issuer: null,
    });
  });

  it("carries Python's whitespace-issuer defect, on purpose", () => {
    // ⚠ NOT a bug in this test. Python's guard is truthiness-only, so a
    // whitespace issuer survives on BOTH arms and then canonicalizes to "",
    // producing a third digest distinct from null and from "". Fixing it here
    // alone would split every issuer-bearing hash across the two SDKs. Pinned
    // so whichever arm is fixed first reds the other.
    expect(normalizePrincipal({ userId: "e-1", issuer: "   " })).toEqual({
      userId: "e-1",
      issuer: "   ",
    });
  });
});

describe("userIdForPrincipal", () => {
  it("drops the field in hashed mode with no key, rather than falling back to raw", () => {
    // The fallback would be a residency breach that looks like success:
    // present, populated, and carrying the subject verbatim.
    expect(
      userIdForPrincipal({ userId: "alice@acme.example" }, { mode: "hashed", tenantId: "t" }),
    ).toBeNull();
    expect(
      userIdForPrincipal(
        { userId: "alice@acme.example" },
        { mode: "hashed", tenantId: "t", key: null },
      ),
    ).toBeNull();
  });

  it("returns the subject verbatim and UNTAGGED in raw mode", () => {
    expect(
      userIdForPrincipal({ userId: "alice@acme.example" }, { mode: "raw", tenantId: "t" }),
    ).toBe("alice@acme.example");
  });

  it("caps a RAW user_id at the same length Python does", () => {
    // Raw mode copies vendor text onto EVERY event of a call — three tool-call
    // legs plus annotations — so unbounded is unbounded several times over. A
    // hook returning a JWT is the realistic shape.
    const long = "u".repeat(500);
    const got = userIdForPrincipal({ userId: long }, { mode: "raw", tenantId: "t" });
    expect(got).toHaveLength(RAW_USER_ID_MAX_LEN);
    expect(RAW_USER_ID_MAX_LEN).toBe(128);

    // ⚠ **The cap counts CODE POINTS**, because a plain `.slice()` counts
    // UTF-16 units and would cut this subject through the middle of the emoji
    // — shipping a lone surrogate on `user_id`, which this same module refuses
    // on the way IN, and disagreeing with Python's `user_id[:128]`. The
    // all-ASCII case above cannot see it; that is why this one exists.
    const astral = `${"u".repeat(127)}😀tail`;
    const capped = userIdForPrincipal({ userId: astral }, { mode: "raw", tenantId: "t" });
    expect(capped).not.toBeNull();
    expect([...capped!]).toHaveLength(RAW_USER_ID_MAX_LEN);
    expect(capped!.endsWith("😀")).toBe(true);
    expect(/\p{Surrogate}/u.test(capped!)).toBe(false);
  });

  it("tags a hook principal as ASSERTED by default", () => {
    const got = userIdForPrincipal({ userId: "e-1" }, { mode: "hashed", tenantId: "t", key: "k" });
    expect(got?.startsWith(`${VENDOR_HASH_SCHEME}:`)).toBe(true);
  });
});
