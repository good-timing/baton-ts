import { describe, expect, it } from "vitest";

import {
  HASH_SCHEME,
  PRINCIPAL_FORM_HASHED,
  PRINCIPAL_FORM_RAW,
  PRINCIPAL_SOURCE_ASSERTED,
  RAW_PRINCIPAL_ID_MAX_LEN,
  hashPrincipalId,
  normalizePrincipal,
  principalFor,
} from "../src/identity.js";
import vectors from "./identityVectors.json" with { type: "json" };

/** The differential corpus. Every `expected` here was produced by Python's
 * `baton.identity.hash_principal_id` and written by `scripts/gen_identity_vectors.py`
 * — nothing in this file is hand-derived, which is the whole point. A hand
 * -written expectation only proves this implementation agrees with whoever
 * wrote the test; these prove it agrees with the other SDK.
 *
 * ⚠ This METHOD is new. `scrub.ts` parity mirrors Python's test matrix
 * case-for-case by hand; nothing there is generated. A generated corpus is the
 * stronger form, and the reason is the same one: a person reaching two SDKs
 * must be ONE actor downstream. */
describe("hashPrincipalId parity with the Python SDK", () => {
  for (const c of vectors.cases) {
    it(`matches Python: ${c.name}`, () => {
      expect(
        hashPrincipalId(c.principal, {
          tenantId: vectors.tenant_id,
          key: vectors.key_utf8,
          issuer: c.issuer,
          scheme: c.scheme,
        }),
      ).toBe(c.expected);
    });
  }

  it("defaults to the key generation Python's corpus was generated under", () => {
    // ⚠ **Pinned by LITERAL, and that is the point of this case.** Every other
    // tag assertion in this file spells the prefix `${HASH_SCHEME}`, which is
    // SELF-REFERENTIAL: change the constant and they all follow it, green. A
    // mutation reviving the retired `v1:` as the value of HASH_SCHEME survived
    // the entire suite for exactly that reason. The corpus's `expected`
    // strings are Python's own output, so comparing the DEFAULT-scheme hash
    // against one of them is the only assertion here that can see the constant
    // move — and it is a wire constant, so a silent move is a split actor
    // across the two SDKs.
    const plain = vectors.cases.find((c) => c.name === "plain ascii");
    expect(plain).toBeDefined();
    expect(plain!.expected.startsWith("h1:")).toBe(true);
    expect(
      hashPrincipalId(plain!.principal, {
        tenantId: vectors.tenant_id,
        key: vectors.key_utf8,
        issuer: plain!.issuer,
      }),
    ).toBe(plain!.expected);
    expect(HASH_SCHEME).toBe("h1");
  });

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

describe("hashPrincipalId properties", () => {
  const KEY = "unit-key";

  it("labels the KEY GENERATION without moving the digest", () => {
    // Load-bearing, and the property that licensed retiring the provenance
    // tag: the scheme is not part of the HMAC message, so relabelling moves
    // the prefix and nothing else. A rotation to `h2:` is therefore the one
    // event that can move a digest, and a change of provenance never was —
    // which is why provenance is `source`, a member, instead.
    const current = hashPrincipalId("e-1", { tenantId: "t", key: KEY });
    const rotated = hashPrincipalId("e-1", { tenantId: "t", key: KEY, scheme: "h2" });

    expect(current.startsWith(`${HASH_SCHEME}:`)).toBe(true);
    expect(current).not.toBe(rotated);
    expect(current.split(":")[1]).toBe(rotated.split(":")[1]);
  });

  it("folds the tenant into the MESSAGE, so one principal cannot correlate across tenants", () => {
    expect(hashPrincipalId("e-1", { tenantId: "t-a", key: KEY, scheme: HASH_SCHEME })).not.toBe(
      hashPrincipalId("e-1", { tenantId: "t-b", key: KEY, scheme: HASH_SCHEME }),
    );
  });

  it("treats a missing issuer as the pre-issuer form", () => {
    // The append-only layout: every hash the proxy and extmcp have emitted
    // since 0.5.0 was issuer-less, and they share this contract.
    const omitted = hashPrincipalId("e-1", { tenantId: "t", key: KEY, scheme: HASH_SCHEME });
    expect(hashPrincipalId("e-1", { tenantId: "t", key: KEY, issuer: null, scheme: HASH_SCHEME })).toBe(omitted);
    expect(hashPrincipalId("e-1", { tenantId: "t", key: KEY, issuer: undefined, scheme: HASH_SCHEME })).toBe(omitted);
  });

  it("separates two people who share a subject under different issuers", () => {
    expect(hashPrincipalId("sub-7", { tenantId: "t", key: KEY, issuer: "https://a.example", scheme: HASH_SCHEME })).not.toBe(
      hashPrincipalId("sub-7", { tenantId: "t", key: KEY, issuer: "https://b.example", scheme: HASH_SCHEME }),
    );
  });

  it("encodes a string key as UTF-8, matching Python's env-var path", () => {
    expect(hashPrincipalId("e-1", { tenantId: "t", key: "🔑", scheme: HASH_SCHEME })).toBe(
      hashPrincipalId("e-1", { tenantId: "t", key: new TextEncoder().encode("🔑"), scheme: HASH_SCHEME }),
    );
  });
});

describe("normalizePrincipal", () => {
  it("accepts a well-formed principal", () => {
    expect(normalizePrincipal({ principalId: "e-1", issuer: "https://idp" })).toEqual({
      principalId: "e-1",
      issuer: "https://idp",
    });
  });

  it("rejects an empty or whitespace-only principalId", () => {
    // The measured divergence from AgentCat, whose falsy-only guard lets
    // `{principalId: ""}` reach their wire. An empty principal hashes to one stable
    // digest naming nobody, merging every such caller into one phantom actor.
    expect(normalizePrincipal({ principalId: "" })).toBeNull();
    expect(normalizePrincipal({ principalId: "   " })).toBeNull();
    expect(normalizePrincipal({ principalId: " " })).toBeNull();
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
    expect(normalizePrincipal({ principalId: `a${HIGH}` })).toBeNull();
    expect(normalizePrincipal({ principalId: `a${LOW}` })).toBeNull();
    // A well-formed pair is NOT a lone surrogate and must still resolve —
    // otherwise the guard eats every emoji-bearing subject.
    expect(normalizePrincipal({ principalId: "a😀" })).toEqual({ principalId: "a😀", issuer: null });
  });

  it("drops a malformed ISSUER but keeps the identity", () => {
    const HIGH = String.fromCharCode(0xd800);
    expect(normalizePrincipal({ principalId: "e-1", issuer: `https://idp${HIGH}` })).toEqual({
      principalId: "e-1",
      issuer: null,
    });
  });

  it("treats anything that is not a principal-shaped object as a miss", () => {
    // Types vanish at runtime and a hook is vendor code; the prior art returns
    // a bare object, so these are the shapes that actually arrive.
    for (const junk of [null, undefined, "e-1", 42, [], { principal_id: "e-1" }, { userId: "e-1" }, { principalId: 7 }]) {
      expect(normalizePrincipal(junk)).toBeNull();
    }
  });

  it("drops a non-string or empty issuer rather than losing the whole principal", () => {
    // A junk issuer costs the ISSUER, not the identity — the subject still
    // resolves, which is the difference between a degraded actor and no actor.
    expect(normalizePrincipal({ principalId: "e-1", issuer: 7 })).toEqual({
      principalId: "e-1",
      issuer: null,
    });
    expect(normalizePrincipal({ principalId: "e-1", issuer: "" })).toEqual({
      principalId: "e-1",
      issuer: null,
    });
  });

  it("carries Python's whitespace-issuer defect, on purpose", () => {
    // ⚠ NOT a bug in this test. Python's guard is truthiness-only, so a
    // whitespace issuer survives on BOTH arms and then canonicalizes to "",
    // producing a third digest distinct from null and from "". Fixing it here
    // alone would split every issuer-bearing hash across the two SDKs. Pinned
    // so whichever arm is fixed first reds the other.
    expect(normalizePrincipal({ principalId: "e-1", issuer: "   " })).toEqual({
      principalId: "e-1",
      issuer: "   ",
    });
  });
});

describe("principalFor", () => {
  it("drops the field in hashed mode with no key, rather than falling back to raw", () => {
    // The fallback would be a residency breach that looks like success:
    // present, populated, and carrying the subject verbatim.
    expect(
      principalFor({ principalId: "alice@acme.example" }, { mode: "hashed", tenantId: "t" }),
    ).toBeNull();
    expect(
      principalFor(
        { principalId: "alice@acme.example" },
        { mode: "hashed", tenantId: "t", key: null },
      ),
    ).toBeNull();
  });

  it("returns the subject verbatim and UNTAGGED in raw mode", () => {
    expect(
      principalFor({ principalId: "alice@acme.example" }, { mode: "raw", tenantId: "t" })?.id,
    ).toBe("alice@acme.example");
  });

  it("caps a RAW principal id at the same length Python does", () => {
    // Raw mode copies vendor text onto EVERY event of a call — three tool-call
    // legs plus annotations — so unbounded is unbounded several times over. A
    // hook returning a JWT is the realistic shape.
    const long = "u".repeat(500);
    const got = principalFor({ principalId: long }, { mode: "raw", tenantId: "t" });
    expect(got?.id).toHaveLength(RAW_PRINCIPAL_ID_MAX_LEN);
    expect(RAW_PRINCIPAL_ID_MAX_LEN).toBe(128);

    // ⚠ **The cap counts CODE POINTS**, because a plain `.slice()` counts
    // UTF-16 units and would cut this subject through the middle of the emoji
    // — shipping a lone surrogate on `principal_id`, which this same module refuses
    // on the way IN, and disagreeing with Python's `principal_id[:128]`. The
    // all-ASCII case above cannot see it; that is why this one exists.
    const astral = `${"u".repeat(127)}😀tail`;
    const capped = principalFor({ principalId: astral }, { mode: "raw", tenantId: "t" });
    expect(capped).not.toBeNull();
    expect([...capped!.id]).toHaveLength(RAW_PRINCIPAL_ID_MAX_LEN);
    expect(capped!.id.endsWith("😀")).toBe(true);
    expect(/\p{Surrogate}/u.test(capped!.id)).toBe(false);
  });

  it("names a hook principal ASSERTED in its own member, not in the tag", () => {
    // ⚠ **This test INVERTED, and the inversion is the point of the change.**
    // It used to assert the digest carried a `v1:` prefix, because the tag was
    // the only place provenance lived. Provenance is now `source`, which
    // survives raw mode — where there is no tag at all — and the tag is the
    // key generation for both rungs. The old shape could not hold this
    // assertion: under it, "asserted" and "h1" were the same three bytes.
    const hashed = principalFor({ principalId: "e-1" }, { mode: "hashed", tenantId: "t", key: "k" });
    expect(hashed).toEqual({
      id: expect.stringMatching(new RegExp(`^${HASH_SCHEME}:[0-9a-f]{64}$`)),
      source: PRINCIPAL_SOURCE_ASSERTED,
      form: PRINCIPAL_FORM_HASHED,
    });

    // The half a tag structurally cannot carry: raw mode emits an untagged
    // value and STILL names its provenance.
    const raw = principalFor({ principalId: "e-1" }, { mode: "raw", tenantId: "t" });
    expect(raw).toEqual({ id: "e-1", source: PRINCIPAL_SOURCE_ASSERTED, form: PRINCIPAL_FORM_RAW });
  });
});
