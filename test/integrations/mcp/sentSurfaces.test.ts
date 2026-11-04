import { describe, expect, it } from "vitest";
import { SENT_SURFACES_CAP, SentSurfaces } from "../../../src/integrations/mcp/surface.js";

describe("SentSurfaces", () => {
  it("forgets the least recently seen hash first", () => {
    const sent = new SentSurfaces();
    for (let i = 0; i < SENT_SURFACES_CAP; i++) sent.mark(`h${i}`);
    // Seen again, so h1 is now the least recent.
    sent.wasSent("h0");
    sent.mark("new");

    expect(sent.wasSent("h0")).toBe(true);
    expect(sent.wasSent("h1")).toBe(false);
  });

  it("does not take a slot for a hash it is only asked about", () => {
    const sent = new SentSurfaces();
    for (let i = 0; i < SENT_SURFACES_CAP; i++) sent.mark(`h${i}`);
    expect(sent.wasSent("asked")).toBe(false);

    expect(sent.wasSent("h0")).toBe(true);
    expect(sent.wasSent("asked")).toBe(false);
  });
});
