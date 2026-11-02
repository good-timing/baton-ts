import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlank, stripWhiteSpace } from "../src/_text.js";
import { parseDsn } from "../src/dsn.js";
import { callerFor } from "../src/identity.js";
import { newSession } from "../src/library/session.js";
import { captureDisabled } from "../src/optout.js";
import { isReport } from "../src/integrations/mcp/annotation.js";
import { errorText } from "../src/integrations/mcp/errorResult.js";
import { withVendorInstructions } from "../src/integrations/mcp/llmText.js";
import type { Extra } from "../src/integrations/mcp/mcpTypes.js";
import { resolveSessionId } from "../src/integrations/mcp/sessionResolution.js";

// SPEC §11.4: blank means Unicode White_Space. U+001C-U+001F are where
// `str.strip()` differs; U+FEFF and U+0085 are where `.trim()` does.
const BOM = String.fromCharCode(0xfeff);
const NEL = String.fromCharCode(0x85);
const SEPARATORS = [0x1c, 0x1d, 0x1e, 0x1f].map((c) => String.fromCharCode(c));
const NOT_WHITE_SPACE = [...SEPARATORS, BOM];
// One from each side is enough at a call site; the helper is pinned above them.
const SAMPLES = [SEPARATORS[0]!, BOM];
const hex = (ch: string) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
const labelled = (chars: string[]) => chars.map((ch) => [hex(ch), ch]);
const padded = (ch: string) => ` ${ch}\t`;

describe("Unicode White_Space", () => {
  it("is exactly the SPEC set", () => {
    const blank: number[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (isBlank(String.fromCharCode(c))) blank.push(c);
    }
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    expect(blank).toEqual([
      ...range(0x09, 0x0d),
      0x20,
      0x85,
      0xa0,
      0x1680,
      ...range(0x2000, 0x200a),
      0x2028,
      0x2029,
      0x202f,
      0x205f,
      0x3000,
    ]);
  });

  it.each(labelled(NOT_WHITE_SPACE))("keeps U+%s and strips the White_Space around it", (_hex, ch) => {
    expect(stripWhiteSpace(`${NEL}${ch}\u3000`)).toBe(ch);
  });

  it("strips a long value in linear time", () => {
    const inner = `a${" ".repeat(200_000)}b`;
    const started = performance.now();
    expect(stripWhiteSpace(` ${inner} `)).toBe(inner);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe.each(labelled(SAMPLES))("a value padded around U+%s is not blank", (_hex, ch) => {
  it("as a principal id, sent as given", () => {
    expect(callerFor({ principalId: padded(ch) }, () => {}).principal?.id).toBe(padded(ch));
  });

  it("as an annotation's account", () => {
    expect(isReport(padded(ch))).toBe(true);
  });

  it("as a library session id, stripped", () => {
    expect(newSession({ sessionId: padded(ch) }, (v) => v, true).sessionId).toBe(ch);
  });

  it("as an error result's text, stripped", () => {
    expect(errorText({ content: [{ type: "text", text: padded(ch) }] })).toBe(ch);
  });

  it("as the vendor's instructions", () => {
    expect(withVendorInstructions({ _instructions: padded(ch) }, "ours")).toBe(`${padded(ch)}\n\nours`);
  });
});

// A header holds Latin-1 only, so U+FEFF cannot arrive in one.
it("strips an mcp-session-id header to U+001C", async () => {
  const extra = { requestInfo: { headers: { "mcp-session-id": padded(SEPARATORS[0]!) } } } as Extra;
  expect((await resolveSessionId("fallback", extra)).sessionId).toBe(SEPARATORS[0]);
});

describe("U+0085 alone is blank", () => {
  it("as an annotation's account", () => {
    expect(isReport(NEL)).toBe(false);
  });

  it("as an mcp-session-id header", async () => {
    const extra = { requestInfo: { headers: { "mcp-session-id": NEL } } } as Extra;
    expect((await resolveSessionId("fallback", extra)).origin).toBe("minted");
  });

  it("as a DSN", () => {
    expect(() => parseDsn(NEL)).toThrow("non-empty");
  });
});

describe("BATON_DISABLED", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(labelled(SAMPLES))("reads 0 followed by U+%s as on", (_hex, ch) => {
    vi.stubEnv("BATON_DISABLED", `0${ch}`);
    expect(captureDisabled()).toBe("BATON_DISABLED");
  });

  it("reads 0 padded with U+0085 as 0", () => {
    vi.stubEnv("BATON_DISABLED", `${NEL}0`);
    expect(captureDisabled()).toBeNull();
  });
});
