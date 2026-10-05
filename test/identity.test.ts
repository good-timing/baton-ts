import { describe, expect, it } from "vitest";

import {
  PRINCIPAL_FORM_HASHED,
  PRINCIPAL_FORM_RAW,
  PRINCIPAL_SOURCE_ASSERTED,
  PRINCIPAL_ID_MAX_LEN,
  DISPLAY_NAME_MAX_LEN,
  normalizePrincipal,
  principalFor,
} from "../src/identity.js";
import { PrincipalWireSchema } from "../src/events.js";

describe("the principal object's REQUIRED shape", () => {
  it("names the provenance by the LITERAL the spec registers, not by our constant", () => {
    // Pinned by literal: an assertion spelled with the constant follows it
    // wherever it goes, and SPEC §11.4 forbids presenting an asserted
    // principal as verified, so the negative is the load-bearing half.
    expect(PRINCIPAL_SOURCE_ASSERTED).toBe("asserted");
    expect(PRINCIPAL_SOURCE_ASSERTED).not.toBe("attested");
    expect(PRINCIPAL_FORM_HASHED).toBe("hashed");
    expect(PRINCIPAL_FORM_RAW).toBe("raw");

    expect(principalFor({ principalId: "e-1" }).source).toBe("asserted");
  });

  it("refuses a PARTIAL object — all three members or nothing", () => {
    const whole = { id: "abc", source: "asserted", form: "hashed" };
    expect(PrincipalWireSchema.safeParse(whole).success).toBe(true);
    for (const missing of ["id", "source", "form"] as const) {
      const partial: Record<string, unknown> = { ...whole };
      delete partial[missing];
      expect(PrincipalWireSchema.safeParse(partial).success).toBe(false);
    }
    // An unknown member is malformed, not richer.
    expect(PrincipalWireSchema.safeParse({ ...whole, scheme: "h1" }).success).toBe(false);
  });
});

describe("normalizePrincipal", () => {
  it("accepts a well-formed principal and keeps the form the hook stated", () => {
    expect(normalizePrincipal({ principalId: "e-1" })).toEqual({ principalId: "e-1" });
    expect(normalizePrincipal({ principalId: "9f2c", form: "hashed" })).toEqual({
      principalId: "9f2c",
      form: "hashed",
    });
  });

  it("rejects an empty or whitespace-only principalId", () => {
    // A blank id names nobody, and every such caller would merge into one actor.
    expect(normalizePrincipal({ principalId: "" })).toBeNull();
    expect(normalizePrincipal({ principalId: "   " })).toBeNull();
    expect(normalizePrincipal({ principalId: " " })).toBeNull();
  });

  it("rejects an id holding U+0000", () => {
    expect(normalizePrincipal({ principalId: "jane\u0000" })).toBeNull();
  });

  it("rejects a lone surrogate, which would otherwise MERGE distinct people", () => {
    const HIGH = String.fromCharCode(0xd800);
    const LOW = String.fromCharCode(0xdc00);
    expect(normalizePrincipal({ principalId: `a${HIGH}` })).toBeNull();
    expect(normalizePrincipal({ principalId: `a${LOW}` })).toBeNull();
    // A well-formed pair is NOT a lone surrogate and must still resolve —
    // otherwise the guard eats every emoji-bearing subject.
    expect(normalizePrincipal({ principalId: "a😀" })).toEqual({ principalId: "a😀" });
  });

  it("treats anything that is not a principal-shaped object as a miss", () => {
    // Types vanish at runtime and a hook is vendor code.
    for (const junk of [null, undefined, "e-1", 42, [], { principal_id: "e-1" }, { userId: "e-1" }, { principalId: 7 }]) {
      expect(normalizePrincipal(junk)).toBeNull();
    }
  });

  it("does not carry members the wire has no place for", () => {
    expect(normalizePrincipal({ principalId: "e-1", issuer: "https://idp" })).toEqual({
      principalId: "e-1",
    });
  });
});

describe("principalFor", () => {
  it("sends the id exactly as the hook returned it, and calls it raw", () => {
    expect(principalFor({ principalId: "Alice@Acme.example" })).toEqual({
      id: "Alice@Acme.example",
      source: PRINCIPAL_SOURCE_ASSERTED,
      form: PRINCIPAL_FORM_RAW,
    });
  });

  it("sends the form the hook stated, with the id untouched", () => {
    expect(principalFor({ principalId: "9F2C-not-hex", form: "hashed" })).toEqual({
      id: "9F2C-not-hex",
      source: PRINCIPAL_SOURCE_ASSERTED,
      form: PRINCIPAL_FORM_HASHED,
    });
    expect(principalFor({ principalId: "e-1", form: "raw" }).form).toBe("raw");
  });

  it.each([["encrypted"], ["HASHED"], [""], [7], [null], [true]])(
    "sends an unregistered form (%j) as raw, and says so",
    (form) => {
      // SPEC §11.4: anything not exactly "hashed" is personal data.
      const seen: unknown[] = [];
      const got = principalFor({ principalId: "e-1", form }, (f) => seen.push(f));
      expect(got.form).toBe("raw");
      expect(got.id).toBe("e-1");
      expect(seen).toEqual([form]);
    },
  );

  it("does not warn for a registered or an omitted form", () => {
    const seen: unknown[] = [];
    principalFor({ principalId: "e-1" }, (f) => seen.push(f));
    principalFor({ principalId: "e-1", form: "hashed" }, (f) => seen.push(f));
    expect(seen).toEqual([]);
  });

  it("caps the id at the same length Python does, in CODE POINTS", () => {
    const long = "u".repeat(500);
    expect(principalFor({ principalId: long }).id).toHaveLength(PRINCIPAL_ID_MAX_LEN);
    expect(PRINCIPAL_ID_MAX_LEN).toBe(128);

    // A plain `.slice()` counts UTF-16 units and would cut this id through
    // the middle of the emoji, shipping a lone surrogate.
    const astral = `${"u".repeat(127)}😀tail`;
    const capped = principalFor({ principalId: astral });
    expect([...capped.id]).toHaveLength(PRINCIPAL_ID_MAX_LEN);
    expect(capped.id.endsWith("😀")).toBe(true);
    expect(/\p{Surrogate}/u.test(capped.id)).toBe(false);
  });
});

describe("display_name on the wire (SPEC §11.4)", () => {
  const named = (displayName: unknown, form: "hashed" | "raw" = "hashed") =>
    principalFor(normalizePrincipal({ principalId: "alice", form, displayName })!);

  it.each(["hashed", "raw"] as const)("rides a %s id", (form) => {
    const got = named("Alice", form);
    expect(got.display_name).toBe("Alice");
    expect(PrincipalWireSchema.safeParse(got).success).toBe(true);
  });

  it("parses a null name — SPEC makes null and absent equivalent, and Python may send it", () => {
    expect(PrincipalWireSchema.safeParse({ id: "x", source: "asserted", form: "raw", display_name: null }).success).toBe(true);
  });

  it("is OMITTED, never null, when there is none — a nameless principal is unchanged", () => {
    expect(Object.keys(named(null))).toEqual(["id", "source", "form"]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["ascii space", " \t\n"],
    ["NEL and ideographic space", "\u0085\u3000"],
    ["non-string", 7],
    ["over cap", "a".repeat(DISPLAY_NAME_MAX_LEN + 1)],
    ["lone surrogate", "a\uD800"],
    ["NUL", "jane\u0000"],
  ])("drops an unusable name (%s) and keeps the id", (_label, value) => {
    const got = named(value);
    expect(got.id).toBeTruthy();
    expect(got.display_name).toBeUndefined();
  });

  it.each([
    ["padded", " Alice "],
    ["info separator", "\u001c"],
    ["BOM", "\uFEFF"],
    ["at cap", "a".repeat(DISPLAY_NAME_MAX_LEN)],
    ["astral at cap, counted in code points", "😀".repeat(DISPLAY_NAME_MAX_LEN)],
  ])("sends a usable name (%s) verbatim", (_label, value) => {
    // Blank is Unicode White_Space exactly: `.trim()` would drop U+FEFF,
    // Python's `strip()` would drop U+001C, and the two SDKs must agree.
    expect(named(value).display_name).toBe(value);
  });
});
