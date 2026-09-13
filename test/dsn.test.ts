/**
 * The DSN parser — the contract between the console's mint and this SDK.
 *
 * The console mints the string; this module is the only thing that reads it. A
 * parser that is STRICTER than the mint refuses valid keys in the field, which
 * is why several cases below assert deliberate PERMISSIVENESS rather than
 * rejection.
 *
 * Three rules this file is built to hold — the first two ported from
 * `baton` (Python)'s `tests/test_dsn.py`, the third specific to this runtime:
 *
 * 1. **No error ever repeats the credential.** A DSN carries a bearer, and an
 *    exception carrying one lands in stack traces, log aggregators and pasted
 *    issue reports. Every throwing case asserts the key is absent from the
 *    message, not merely that a message appeared.
 * 2. **The ingest origin is scheme + authority and nothing else.** The path
 *    segments are DATA. A parser that folds them into the URL, or that appends
 *    `/v0/events` itself, reproduces a double-append this project has already
 *    shipped once — so the origin is asserted by equality, never by substring.
 * 3. **The key crosses VERBATIM.** WHATWG URL parsing percent-encodes
 *    userinfo, and the bearer is hashed whole server-side, so one rewritten
 *    byte produces a key that matches no row.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { VENDOR_ID_PATTERN, parseDsn, redact, selectDsn } from "../src/dsn.js";

const WORKSPACE = "ten_655b084e118b43f88992ee6357fcc23c";
const KEY = "baton_pk_" + "a".repeat(43);
const DSN = `https://${KEY}@ingest.goodtiming.ai/${WORKSPACE}/echo-server`;

/** Captures `process.emitWarning`, which is how this package warns (stdout is
 * the JSON-RPC stream under stdio transport, so nothing may print there). */
function captureWarnings(): { text: () => string } {
  const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  return { text: () => spy.mock.calls.map((call) => String(call[0])).join("\n") };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BATON_DSN;
});

describe("the happy path", () => {
  it("unpacks all four values", () => {
    expect(parseDsn(DSN)).toEqual({
      origin: "https://ingest.goodtiming.ai",
      tenantId: WORKSPACE,
      vendorId: "echo-server",
      key: KEY,
    });
  });

  it("carries no path in the origin", () => {
    // Asserted by EQUALITY. `HttpSink` appends `/v0/events` to this value, so
    // an origin that kept the workspace and server segments would POST to a
    // URL that does not exist — and a substring check would pass happily on
    // exactly that bug.
    expect(parseDsn(DSN).origin).toBe("https://ingest.goodtiming.ai");
  });

  it("ignores a trailing slash", () => {
    expect(parseDsn(DSN + "/")).toEqual(parseDsn(DSN));
  });

  it("accepts http for local development", () => {
    expect(parseDsn(`http://${KEY}@localhost:8000/${WORKSPACE}/echo-server`).origin).toBe(
      "http://localhost:8000",
    );
  });

  it("keeps the port", () => {
    // The authority is taken verbatim rather than rebuilt from a URL object,
    // which drops a default port and the brackets an IPv6 literal needs.
    expect(parseDsn(`https://${KEY}@127.0.0.1:9443/${WORKSPACE}/srv`).origin).toBe(
      "https://127.0.0.1:9443",
    );
  });

  it("keeps an IPv6 literal's brackets and its default port", () => {
    // `new URL("https://[::1]:443").host` is `"[::1]"` — the port is dropped
    // because it is https's default. The authority never goes through it.
    expect(parseDsn(`https://${KEY}@[::1]:443/${WORKSPACE}/srv`).origin).toBe(
      "https://[::1]:443",
    );
  });

  it("treats the whole key as the bearer", () => {
    // Prefix included. The auth layer hashes the entire string, so a parser
    // that helpfully stripped `baton_pk_` would hand the collector a value
    // that matches no row.
    expect(parseDsn(DSN).key).toBe(KEY);
  });

  it("keeps the workspace's prefix and its case", () => {
    // `ten_` is part of the id. And the value is compared as a string
    // server-side, so this parser must never normalise it.
    const mixed = "ten_655B084E118B43F88992EE6357FCC23C";
    expect(parseDsn(`https://${KEY}@h.example.com/${mixed}/srv`).tenantId).toBe(mixed);
  });
});

describe("the key crosses verbatim", () => {
  // The reason this module hand-rolls its split instead of using `new URL`.
  // Measured on Node: `new URL("https://a@b@host/x/y").username` is `"a%40b"`,
  // and `decodeURIComponent` cannot be used to undo it — the tail is
  // deliberately unvalidated, so a literal `%` in one is legal input.

  it("does not percent-encode an @ inside the userinfo", () => {
    const parsed = parseDsn(`https://x@${KEY}@h.example.com/${WORKSPACE}/srv`);
    expect(parsed.key).toBe(`x@${KEY}`);
    expect(parsed.key).not.toContain("%40");
  });

  it("does not rewrite a percent sign in the tail", () => {
    const odd = "baton_pk_aa%bbcc";
    expect(parseDsn(`https://${odd}@h.example.com/${WORKSPACE}/srv`).key).toBe(odd);
  });

  it("does not lowercase or punycode the authority", () => {
    // `new URL` returns `host.example.com` for this, and
    // `xn--mnchen-3ya.de` for an IDN. The origin is the string the vendor
    // wrote, because it is compared against nothing and dialled directly.
    expect(parseDsn(`https://${KEY}@HOST.Example.COM/${WORKSPACE}/srv`).origin).toBe(
      "https://HOST.Example.COM",
    );
  });
});

describe("deliberate permissiveness", () => {
  // Looser than the written grammar, on purpose. Being stricter than the mint
  // breaks a customer; being looser only fails to catch a typo that the
  // collector rejects readably anyway.

  it("does not length-check the key's tail", () => {
    // The grammar says 43 characters and the mint says so today. That number
    // belongs to the console — pinning it here means the day the mint changes,
    // every SDK already in the field refuses every new key.
    for (const tailLength of [32, 43, 44, 80]) {
      const key = "baton_pk_" + "b".repeat(tailLength);
      expect(parseDsn(`https://${key}@h.example.com/${WORKSPACE}/srv`).key).toBe(key);
    }
  });

  it("checks the server segment with the installer's own validator", async () => {
    // Not a second regex restating its ceiling. The DSN's server segment IS a
    // vendorId, and this recipe has already costed that ceiling wrong twice by
    // writing the number down somewhere else.
    const config = await import("../src/integrations/mcp/config.js");
    expect(config.VENDOR_ID_PATTERN).toBe(VENDOR_ID_PATTERN);
  });

  it("accepts a 48-character server and refuses 49", () => {
    // The boundary is READ OFF the validator rather than typed in, so this
    // test cannot outlive a change to it.
    const longest = "s".repeat(48);
    expect(parseDsn(`https://${KEY}@h.example.com/${WORKSPACE}/${longest}`).vendorId).toBe(
      longest,
    );
    expect(() => parseDsn(`https://${KEY}@h.example.com/${WORKSPACE}/${"s".repeat(49)}`)).toThrow(
      /where the server belongs/,
    );
  });
});

describe("the workspace is eight or thirty-two hex", () => {
  // ⚠ The lengths are TYPED IN, not read off WORKSPACE_PATTERN. Deriving them
  // would make this pass under any pattern — including the `^ten_[0-9a-fA-F]+$`
  // that provoked it, which parses `ten_a` and reddened nothing in either
  // suite. Pinning a boundary means naming it where the implementation cannot
  // move it.
  //
  // The adjacent lengths are the discriminating half: 7/9 and 31/33 are what a
  // `+`, a `{8,}` or a `{8,32}` waves through.

  const accepted = [
    ["8 hex, what the mint writes today", "ten_" + "a".repeat(8)],
    ["32 hex, the shape it replaced", "ten_" + "a".repeat(32)],
    ["8 hex uppercase", "ten_" + "A".repeat(8)],
    ["32 hex uppercase", "ten_" + "A".repeat(32)],
    ["a real minted value", "ten_7cd4c8cf"],
  ] as const;

  for (const [name, workspace] of accepted) {
    it(`accepts ${name} and passes it through verbatim`, () => {
      expect(parseDsn(`https://${KEY}@h.example.com/${workspace}/srv`).tenantId).toBe(workspace);
    });
  }

  for (const length of [0, 1, 7, 9, 16, 31, 33, 64]) {
    it(`refuses a run of ${length} hex`, () => {
      const workspace = "ten_" + "a".repeat(length);
      expect(() => parseDsn(`https://${KEY}@h.example.com/${workspace}/srv`)).toThrow(
        /where the workspace belongs/,
      );
    });
  }

  for (const workspace of ["ten_" + "g".repeat(8), "ten_" + "g".repeat(32)]) {
    it(`refuses ${workspace} — length alone is not the rule`, () => {
      expect(() => parseDsn(`https://${KEY}@h.example.com/${workspace}/srv`)).toThrow(
        /where the workspace belongs/,
      );
    });
  }

  // ⚠ This regressed once, in the commit that widened the pattern: the
  // illustrative examples were rewritten 32 -> 8 along with everything else, so
  // a pre-2026-09-12 customer with a 32-hex workspace who made some OTHER
  // mistake was shown `/ten_<8 hex>/<server>` and could "correct" a perfectly
  // good workspace by truncating it. That DSN parses, so the install succeeds
  // and every event then 401s at ingest and is dropped. The length belongs in
  // the one sentence that is ABOUT the length; elsewhere the segment is elided,
  // exactly as the key already is.
  const unrelatedMistakes: [name: string, raw: string][] = [
    ["no server segment", `https://${KEY}@h.example.com/${WORKSPACE}`],
    ["a key in the workspace slot", `https://${KEY}@h.example.com/${KEY}/srv`],
    // ⚠ NOT "a key in the host slot" — `baton`'s test suite covers that row and
    // this one cannot, because THIS PARSER DOES NOT REFUSE IT. Python refuses
    // `https://x@<key>/ten_.../srv` at `_dsn.py:395` ("has the KEY where the
    // host belongs"); there is no such check here, so the DSN parses with the
    // key as the ORIGIN and "x" as the bearer. Tracked separately — this is a
    // port gap, not something the workspace-length change introduced, and it is
    // named here rather than silently dropped from the table.
  ];

  for (const [name, raw] of unrelatedMistakes) {
    it(`shows no single length in the refusal for ${name}`, () => {
      expect(() => parseDsn(raw)).toThrow();
      let message = "";
      try {
        parseDsn(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain("hex");
    });
  }

  it("names both lengths in the refusal", () => {
    // A sentence naming only one of two accepted shapes sends the reader
    // hunting a typo that is not there.
    expect(() => parseDsn(`https://${KEY}@h.example.com/ten_abc/srv`)).toThrow(
      /8 or 32 hex characters/,
    );
  });
});

describe("what it refuses", () => {
  const refusals: [name: string, raw: string, expected: RegExp][] = [
    ["a bare publishable key", KEY, /bare key/],
    ["a bare secret key", "baton_sk_" + "c".repeat(43), /bare key/],
    ["no scheme", `ingest.goodtiming.ai/${WORKSPACE}/srv`, /https:\/\//],
    ["wrong scheme", `ftp://${KEY}@h.example.com/${WORKSPACE}/srv`, /https:\/\//],
    ["no key", `https://h.example.com/${WORKSPACE}/srv`, /carries no key/],
    [
      "a password slot",
      `https://${KEY}:secret@h.example.com/${WORKSPACE}/srv`,
      /no password field/,
    ],
    ["no server segment", `https://${KEY}@h.example.com/${WORKSPACE}`, /exactly two path segments/],
    [
      "three segments",
      `https://${KEY}@h.example.com/${WORKSPACE}/srv/extra`,
      /exactly two path segments/,
    ],
    [
      "segments the wrong way round",
      `https://${KEY}@h.example.com/srv/${WORKSPACE}`,
      /where the workspace belongs/,
    ],
    [
      "a dot in the server name",
      `https://${KEY}@h.example.com/${WORKSPACE}/my.server`,
      /where the server belongs/,
    ],
    ["a query string where the path belongs", `https://${KEY}@h.example.com?a=b`, /two path/],
    ["empty", "", /non-empty/],
    ["whitespace only", "   ", /non-empty/],
  ];

  it.each(refusals)("names the problem: %s", (_name, raw, expected) => {
    expect(() => parseDsn(raw)).toThrow(expected);
  });

  const credentialCases: [name: string, raw: string][] = [
    ["wrong scheme", `ftp://${KEY}@h.example.com/${WORKSPACE}/srv`],
    ["password slot", `https://${KEY}:secret@h.example.com/${WORKSPACE}/srv`],
    ["no server segment", `https://${KEY}@h.example.com/${WORKSPACE}`],
    ["three segments", `https://${KEY}@h.example.com/${WORKSPACE}/srv/extra`],
    ["swapped segments", `https://${KEY}@h.example.com/srv/${WORKSPACE}`],
    ["bad server name", `https://${KEY}@h.example.com/${WORKSPACE}/my.server`],
    ["a query string where the path belongs", `https://${KEY}@h.example.com?a=b`],
  ];

  it.each(credentialCases)("never repeats the credential: %s", (_name, raw) => {
    // The one thing a parse error must not do. Every message above passes
    // through `redact`; this is the test that keeps the next one doing so.
    expect(() => parseDsn(raw)).toThrow();
    try {
      parseDsn(raw);
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain("a".repeat(43));
    }
  });

  it("tells a bare key where to find the real one", () => {
    // The likeliest paste error by far — /account labels the key type
    // "Publishable key" and the string you copy "DSN" — so it earns a sentence
    // rather than a parse error.
    expect(() => parseDsn(KEY)).toThrow(/\/account/);
  });

  it("does not echo a bare key back either", () => {
    try {
      parseDsn(KEY);
      expect.unreachable("a bare key must not parse");
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
  });
});

describe("a secret key warns and works", () => {
  // The row is the authority on what a key may do, not its prefix. An SDK
  // enforcing a console policy turns a typo at the mint site into a confusing
  // client-side error — but a workspace secret inside a server that ships to
  // strangers is worth saying out loud, and this is the only place that can.
  const SECRET = "baton_sk_" + "d".repeat(43);
  const SECRET_DSN = `https://${SECRET}@h.example.com/${WORKSPACE}/srv`;

  it("still parses", () => {
    captureWarnings();
    expect(parseDsn(SECRET_DSN).key).toBe(SECRET);
  });

  it("warns", () => {
    const warnings = captureWarnings();
    parseDsn(SECRET_DSN);
    expect(warnings.text()).toContain("baton_sk_");
    expect(warnings.text().toLowerCase()).toContain("publishable");
  });

  it("does not repeat the secret in the warning", () => {
    // Naming the prefix is the point; naming the key would put a workspace
    // secret into whatever ships the vendor's logs.
    const warnings = captureWarnings();
    parseDsn(SECRET_DSN);
    expect(warnings.text()).not.toContain(SECRET);
    expect(warnings.text()).not.toContain("d".repeat(43));
  });

  it("warns about nothing for a publishable key", () => {
    const warnings = captureWarnings();
    parseDsn(DSN);
    expect(warnings.text()).toBe("");
  });
});

describe("redact", () => {
  it("removes the key and keeps everything useful", () => {
    expect(redact(DSN)).toBe(`https://***@ingest.goodtiming.ai/${WORKSPACE}/echo-server`);
  });

  it("turns a string it cannot split into a marker, not a leak", () => {
    // "I could not parse it" must never turn into "here is your token".
    expect(redact(KEY)).toBe("<dsn>");
    expect(redact("")).toBe("<dsn>");
  });
});

describe("selectDsn", () => {
  // An environment variable is not something the caller passed. Folding the
  // two together let an ambient `BATON_DSN` collide with an explicit config
  // and then blame the caller for a value that appears nowhere in their code —
  // while also inverting this SDK's precedence rule, under which explicit wins
  // and the environment is the fallback.

  it("still throws for an explicit DSN beside an explicit value", () => {
    expect(() => selectDsn(DSN, { vendorId: true }, "BatonConfig")).toThrow(/already supplies it/);
  });

  it("uses an explicit DSN alone", () => {
    expect(selectDsn(DSN, { vendorId: false }, "BatonConfig")).toBe(DSN);
  });

  it("uses an ambient DSN alone", () => {
    // The hosted-vendor case it exists for: one variable instead of five.
    process.env.BATON_DSN = DSN;
    expect(selectDsn(undefined, { vendorId: false, sink: false }, "BatonConfig")).toBe(DSN);
  });

  it("lets an ambient DSN LOSE to an explicit value instead of throwing", () => {
    // The regression this fixes: a vendor who exported BATON_DSN for one
    // server could not install a second one the old explicit way — the install
    // died naming a `dsn` they never wrote.
    process.env.BATON_DSN = DSN;
    captureWarnings();
    expect(selectDsn(undefined, { vendorId: true }, "BatonConfig")).toBeUndefined();
  });

  it("announces being ignored", () => {
    // Silence here is the shape where broken and unbuilt look alike: a healthy
    // install whose events go nowhere near the collector the vendor thinks
    // they configured.
    process.env.BATON_DSN = DSN;
    const warnings = captureWarnings();
    selectDsn(undefined, { vendorId: true, sink: true }, "BatonConfig");
    expect(warnings.text()).toContain("BATON_DSN");
    expect(warnings.text()).toContain("IGNORED");
    // It names WHICH values won, so the vendor can act on it.
    expect(warnings.text()).toContain("sink");
    expect(warnings.text()).toContain("vendorId");
  });

  it("does not repeat the key in the announcement", () => {
    process.env.BATON_DSN = DSN;
    const warnings = captureWarnings();
    selectDsn(undefined, { vendorId: true }, "BatonConfig");
    expect(warnings.text()).not.toContain(KEY);
  });

  it("treats an explicitly EMPTY dsn as unset, not as a conflict", () => {
    // Same rule as the environment read beside it: set-but-empty is how a
    // value that failed to fill arrives. `dsn: process.env.MY_DSN ?? ""` used
    // to kill the install naming a dsn the vendor never wrote, and pointing
    // them at the wrong value to remove.
    expect(selectDsn("", { vendorId: true }, "BatonConfig")).toBeUndefined();
    process.env.BATON_DSN = DSN;
    expect(selectDsn("", { vendorId: false }, "BatonConfig")).toBe(DSN);
  });

  it("is undefined when nothing is set anywhere", () => {
    expect(selectDsn(undefined, { vendorId: true }, "BatonConfig")).toBeUndefined();
  });
});

describe("the leaks review found", () => {
  // All ported from the Python suite, where they got past every case written
  // before them. They are the one failure this module exists to prevent: a
  // bearer token in an exception. Kept together because the lesson is shared —
  // a redaction is only as good as the WORST input anyone can hand it, and
  // cases written from the grammar all happen to be well-formed.

  it("does not carry the key through redact when there is a second @", () => {
    // The Python `redact` split on the FIRST `@` while its parser split on the
    // last, so this input put the credential on the safe-looking side of the
    // split and the "redacted" message shipped it whole.
    const raw = `ftp://x@${KEY}@h.example.com/${WORKSPACE}/srv`;
    expect(redact(raw)).not.toContain(KEY);
    expect(() => parseDsn(raw)).toThrow();
    try {
      parseDsn(raw);
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
  });

  it("does not leak the key through a host the URL parser refuses", () => {
    // Node's `ERR_INVALID_URL` carries the string it was handed on
    // `error.input`. Handed a whole DSN it would carry the bearer; this parser
    // hands it the authority alone, after the split.
    const raw = `https://${KEY}@h℀.example.com/${WORKSPACE}/srv`;
    try {
      parseDsn(raw);
      expect.unreachable("an unparseable host must be refused");
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
      expect(String(error)).toContain("not a parseable URL");
    }
  });

  it.each([
    ["server slot", `https://h.example.com/${WORKSPACE}/${KEY}`],
    ["workspace slot", `https://h.example.com/${KEY}/srv`],
    ["server slot with a real key", `https://${KEY}@h.example.com/${WORKSPACE}/${KEY}`],
    ["workspace slot with a real key", `https://${KEY}@h.example.com/${KEY}/srv`],
  ])("does not echo a key pasted into a PATH slot: %s", (_name, raw) => {
    // The third leak of this kind, and the likeliest paste error of all. A
    // DSN's userinfo and its two path segments look alike to someone copying
    // by eye. Put the key in the path and there is no `@` at all, so `redact`
    // reported "no key" and then printed the path — with the key in it — and
    // the pattern-mismatch messages interpolated the segment on top of that.
    expect(redact(raw)).not.toContain(KEY);
    try {
      parseDsn(raw);
      expect.unreachable("a key in a path slot must be refused");
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
      expect(String(error)).not.toContain("a".repeat(43));
    }
  });

  it("tells a misplaced key which mistake it made", () => {
    // Not merely refused. "carries no key" is true and useless when the key is
    // right there in the path.
    expect(() => parseDsn(`https://h.example.com/${WORKSPACE}/${KEY}`)).toThrow(
      /the key is in the PATH/,
    );
  });

  it("keeps the original message for a genuinely absent key", () => {
    // The two cases must not collapse into one sentence: a vendor who pasted
    // half a DSN and one who pasted it wrong need different advice.
    expect(() => parseDsn(`https://h.example.com/${WORKSPACE}/srv`)).toThrow(
      /the value from \/account/,
    );
  });

  it.each([
    ["nothing but a key", `https://${KEY}`],
    ["a key as the host, with a path", `https://${KEY}/${WORKSPACE}/srv`],
    ["a key as the host, with a port", `https://${KEY}:8000/${WORKSPACE}/srv`],
    ["a key where the scheme's slashes are doubled", `https://${KEY}//${WORKSPACE}/srv`],
  ])("does not echo a key pasted into the AUTHORITY slot: %s", (_name, raw) => {
    // The fourth leak of this kind, and the one the per-slot elision could not
    // see — `elideKey` ran on path segments only, so a key sitting where the
    // host belongs was interpolated whole.
    //
    // It is also the case this parser STEERS people into. A bare key is told
    // "copy the full value from /account, which starts with https://", and the
    // obvious next move is to prepend `https://` to the key already in hand —
    // so the retry, not some exotic input, is what printed the bearer into the
    // boot log.
    expect(redact(raw)).not.toContain(KEY);
    try {
      parseDsn(raw);
      expect.unreachable("a key in the authority slot must be refused");
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
      expect(String(error)).not.toContain("a".repeat(43));
    }
  });

  it("tells the bare-key RETRY what it is still missing", () => {
    // Not merely refused, and not the generic "carries no key" either: this
    // vendor did what the previous error told them to do. The sentence has to
    // name the part they still do not have.
    expect(() => parseDsn(`https://${KEY}`)).toThrow(/bare key with a scheme in front of it/);
    expect(() => parseDsn(`https://${KEY}`)).toThrow(/host, your workspace and your server/);
  });

  it("leaves no credential-shaped run anywhere in a redacted string", () => {
    // The guarantee is one scan of the finished string rather than a list of
    // slots that each remember to elide, so this asserts the SHAPE is gone
    // rather than that one known slot was handled. A slot added later cannot
    // quietly opt out of it.
    const secret = "baton_sk_" + "e".repeat(43);
    const malformed = [
      `https://${KEY}`,
      `https://${secret}`,
      `https://${KEY}/${WORKSPACE}`,
      `https://${KEY}@${KEY}/${WORKSPACE}/srv`,
      `https://h.example.com/${KEY}/${secret}`,
      `ftp://${KEY}@h.example.com/${WORKSPACE}/srv`,
      `https://${KEY}@h.example.com/${WORKSPACE}/srv/extra`,
    ];
    for (const raw of malformed) {
      expect(redact(raw)).not.toMatch(/baton_(?:pk|sk)_./);
    }
  });

  it("keeps the bearer out of inspection and serialisation", async () => {
    // `dsn.key` is what the sink reads, so it stays reachable. What must not
    // happen is a publishable key landing in a log the first time anyone
    // debugs their install — `console.log(dsn)` and the `JSON.stringify`
    // inside every structured logger are the two paths that do it.
    const { inspect } = await import("node:util");
    const parsed = parseDsn(DSN);

    expect(parsed.key).toBe(KEY);
    expect(inspect(parsed)).not.toContain(KEY);
    expect(JSON.stringify(parsed)).not.toContain(KEY);
    // A spread must NOT quietly drop it: an object that loses its bearer on
    // copy is a worse trap than the one being closed.
    expect({ ...parsed }.key).toBe(KEY);
    expect(Object.keys(parsed)).toEqual(["origin", "tenantId", "vendorId", "key"]);
  });

  it.each([
    ["glued to the server segment", `https://${KEY}@h.example.com/${WORKSPACE}/srv-${KEY}`],
    ["glued to the workspace segment", `https://${KEY}@h.example.com/x${KEY}/srv`],
    ["glued to a secret key", `https://${KEY}@h.example.com/${WORKSPACE}/srv-baton_sk_${"s".repeat(43)}`],
  ])("does not echo a key GLUED to a path segment: %s", (_name, raw) => {
    // The blind spot in the elision was `startsWith`: a segment carrying a key
    // rather than being one slipped past it and was interpolated into the
    // pattern-mismatch message raw — in the same sentence as its own
    // redaction. Deterministic, not a near miss: a segment with a key glued on
    // is over 48 characters, so it always fails the pattern and always reaches
    // that interpolation.
    expect(redact(raw)).not.toMatch(/baton_(?:pk|sk)_[A-Za-z0-9_%-]{8,}/);
    try {
      parseDsn(raw);
      expect.unreachable("a key in a path segment must be refused");
    } catch (error) {
      expect(String(error)).not.toMatch(/baton_(?:pk|sk)_[A-Za-z0-9_%-]{8,}/);
    }
  });

  it("names the SLOT for a glued key, rather than falling through to the pattern", () => {
    // Two guards cover this input and neither is load-bearing alone: the
    // key-in-slot refusal fires first, and if it did not, the sweep at the
    // throw would clean the pattern-mismatch message instead. Measured —
    // removing either one alone reds nothing, removing both reds the three
    // cases above.
    //
    // So this test exists to pin the half the leak test cannot see: WHICH
    // sentence a vendor gets. "has a KEY in the workspace slot" tells them
    // what they did; "expected ten_ followed by 32 hex characters" describes
    // a string they cannot see, because it has just been redacted.
    expect(() => parseDsn(`https://${KEY}@h.example.com/x${KEY}/srv`)).toThrow(
      /KEY in the workspace slot/,
    );
    expect(() => parseDsn(`https://${KEY}@h.example.com/${WORKSPACE}/srv-${KEY}`)).toThrow(
      /KEY in the server slot/,
    );
  });

  it("still shows the module's own examples and prefix names", () => {
    // The sweep now runs over finished sentences, so the floor on its tail is
    // load-bearing: without one it would eat `baton_pk_...` out of the very
    // example that tells a vendor what a DSN looks like, and `baton_sk_` out
    // of the warning whose entire job is to name that prefix.
    expect(() => parseDsn(`https://h.example.com/${WORKSPACE}/srv`)).toThrow(
      /baton_pk_\.\.\.@host/,
    );
    const warnings = captureWarnings();
    parseDsn(`https://baton_sk_${"d".repeat(43)}@h.example.com/${WORKSPACE}/srv`);
    expect(warnings.text()).toContain("baton_sk_");
    expect(warnings.text()).toContain("baton_pk_");
  });

  it.each([
    ["a tab", "\t"],
    ["a line feed", "\n"],
    ["a carriage return", "\r"],
    ["a vertical tab", "\v"],
    ["a form feed", "\f"],
    ["a space", " "],
    ["a null", "\x00"],
    ["a unit separator", "\x1f"],
    ["a delete", "\x7f"],
  ])("refuses %s inside the host", (_name, ch) => {
    // The backslash guard could not see these: WHATWG REMOVES them before
    // parsing rather than folding them, so the host comes out as one joined
    // name and `pathname` is still `/`. `fetch` strips identically, so the
    // request would go to a host the vendor never wrote — silently, at the
    // first tool call. Measured that these three are the whole strip set:
    // every other control character makes `new URL` throw.
    expect(() =>
      parseDsn(`https://${KEY}@ingest.example.com${ch}evil.com/${WORKSPACE}/srv`),
    ).toThrow(/whitespace, a control character or a backslash/);
  });

  it.each([
    ["a trailing space", " "],
    ["a trailing vertical tab", "\v"],
    ["a trailing null", "\x00"],
  ])("refuses %s at the END of the host", (_name, ch) => {
    // ⚠ The first guard here listed three characters and called the set
    // closed, on a measurement taken in ONE POSITION. WHATWG strips leading
    // and trailing C0 controls AND the space as well, so these parsed clean
    // with `pathname` still `/` — then `HttpSink` appended `/v0/events`, which
    // put the character mid-string, and `fetch` threw on every send inside the
    // sink's bare catch. Retried, dropped, forever, from an install that
    // raised nothing. The likely real input is a DSN copied with a stray space
    // before the path.
    expect(() => parseDsn(`https://${KEY}@ingest.example.com${ch}/${WORKSPACE}/srv`)).toThrow(
      /whitespace, a control character or a backslash/,
    );
  });

  it.each([
    ["a line feed", "\n"],
    ["a carriage return", "\r"],
    ["a null", "\x00"],
  ])("refuses %s inside the KEY", (_name, ch) => {
    // Measured, not assumed: `new Headers` rejects exactly these three and
    // accepts every other control character, so these are the ones that could
    // never have been sent — `Authorization: Bearer <key>` throws inside
    // `HttpSink`'s bare catch and retries forever. The key is the longest part
    // of a DSN, so it is where a line wrap most likely lands, and the host
    // message says nothing about it.
    expect(() =>
      parseDsn(`https://baton_pk_aaaa${ch}aaaa@h.example.com/${WORKSPACE}/srv`),
    ).toThrow(/never be sent in an Authorization header/);
  });

  it("still accepts the control characters a bearer CAN carry", () => {
    // Narrow on purpose: the tail's alphabet belongs to the console's mint,
    // and a parser stricter than the mint refuses valid keys in the field.
    const odd = "baton_pk_aaaa\x0baaaa";
    expect(parseDsn(`https://${odd}@h.example.com/${WORKSPACE}/srv`).key).toBe(odd);
  });

  it("refuses a backslash-smuggled path in the authority", () => {
    // WHATWG folds `\` to `/` for special schemes, so `new URL` accepted
    // `host\evil` as a host with a path — while the split kept the whole
    // thing as the authority. `HttpSink` would then append `/v0/events` to
    // `https://host\evil`, which `fetch` resolves to
    // `https://host/evil/v0/events`: a 404 at the first tool call, from an
    // install that raised nothing.
    //
    // Refused by the character class now rather than by the assertion on what
    // the URL parser made of the authority — `\` is in `_NOT_IN_A_HOST`, and
    // one rule owning one message beats two rules answering for one input.
    expect(() =>
      parseDsn(`https://${KEY}@ingest.example.com\\evil/${WORKSPACE}/srv`),
    ).toThrow(/whitespace, a control character or a backslash/);
  });

  it("attaches no cause carrying the original", () => {
    // `cause` is the TypeScript twin of Python's `__context__`: suppressing
    // the printed traceback is not enough, because anything walking the chain
    // — an error reporter, a structured logger, vitest's own diff — still
    // reaches the string we just redacted.
    const raw = `https://${KEY}@h℀.example.com/${WORKSPACE}/srv`;
    try {
      parseDsn(raw);
      expect.unreachable("an unparseable host must be refused");
    } catch (error) {
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify((error as Error).cause ?? null)).not.toContain(KEY);
    }
  });
});
