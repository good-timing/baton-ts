/**
 * Tests for `roundMetaCoordinates` (`src/metaCoordinates.ts`), handoff D5.
 *
 * The rule the Python SDK's `round_meta_coordinates` carries, case for case,
 * so the two SDKs store the same `runtime_meta` for the same client. That
 * params and results are NOT rounded is a property of the call site, so it
 * is asserted end to end in `integrations/mcp/withBaton.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { roundMetaCoordinates } from "../src/metaCoordinates.js";
import { DEPTH_LIMIT } from "../src/scrub.js";
import { CHATGPT_IPHONE_META, CHATGPT_MAC_BROWSER_META } from "./openaiMetaSamples.js";

function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value = leaf;
  for (let i = 0; i < levels; i += 1) value = { n: value };
  return value;
}

describe("roundMetaCoordinates", () => {
  it("rounds the ChatGPT Mac browser sample and changes nothing else", () => {
    expect(roundMetaCoordinates(CHATGPT_MAC_BROWSER_META)).toEqual({
      ...CHATGPT_MAC_BROWSER_META,
      "openai/userLocation": {
        ...CHATGPT_MAC_BROWSER_META["openai/userLocation"],
        latitude: "37.8",
        longitude: "-122.4",
      },
    });
  });

  it("rounds the ChatGPT iPhone sample and changes nothing else", () => {
    expect(roundMetaCoordinates(CHATGPT_IPHONE_META)).toEqual({
      ...CHATGPT_IPHONE_META,
      "openai/userLocation": {
        ...CHATGPT_IPHONE_META["openai/userLocation"],
        latitude: "37.8",
        longitude: "-122.4",
      },
    });
  });

  it("does not modify the meta it is given", () => {
    const before = structuredClone(CHATGPT_IPHONE_META);
    roundMetaCoordinates(CHATGPT_IPHONE_META);
    expect(CHATGPT_IPHONE_META).toEqual(before);
  });

  it("rounds a number and keeps it a number", () => {
    expect(roundMetaCoordinates({ latitude: 37.79535 })).toEqual({ latitude: 37.8 });
  });

  it("leaves an integer, a boolean, null, NaN and Infinity alone", () => {
    const input = {
      latitude: 37,
      longitude: true,
      a: { latitude: null },
      b: { latitude: Number.NaN, longitude: Number.POSITIVE_INFINITY },
    };
    expect(roundMetaCoordinates(input)).toEqual(input);
  });

  it("leaves a string that is not a plain decimal alone", () => {
    // Whole string, no trimming: the Python SDK's `_DECIMAL.fullmatch`.
    const input = {
      latitude: "unknown",
      longitude: "3.779535e1",
      a: { latitude: " 37.79535 " },
      b: { latitude: "NaN", longitude: "Infinity" },
    };
    expect(roundMetaCoordinates(input)).toEqual(input);
  });

  it("matches the key case-insensitively", () => {
    expect(roundMetaCoordinates({ Latitude: "37.79535", LONGITUDE: "-122.39366" })).toEqual({
      Latitude: "37.8",
      LONGITUDE: "-122.4",
    });
  });

  it("does not match a key that abbreviates it", () => {
    const input = { lat: "37.79535", lng: "-122.39366" };
    expect(roundMetaCoordinates(input)).toEqual(input);
  });

  it("writes one decimal always, and rounds an exact tie the way Python does", () => {
    // Python's `f"{x:.1f}"` takes a tie to the even digit; `toFixed` alone
    // would store "-122.3" and 37.3 here.
    expect(roundMetaCoordinates({ latitude: "37", longitude: "-122.25" })).toEqual({
      latitude: "37.0",
      longitude: "-122.2",
    });
    expect(roundMetaCoordinates({ latitude: 37.25, longitude: 37.75 })).toEqual({
      latitude: 37.2,
      longitude: 37.8,
    });
  });

  it("reaches coordinates in nested objects and arrays, not values under the key", () => {
    expect(
      roundMetaCoordinates({
        places: [{ latitude: "37.79535" }],
        a: { b: { longitude: -122.39366 } },
        latitude: ["37.79535"],
      }),
    ).toEqual({
      places: [{ latitude: "37.8" }],
      a: { b: { longitude: -122.4 } },
      latitude: ["37.79535"],
    });
  });

  it("stops at DEPTH_LIMIT, where the Scrubber stops", () => {
    // `meta` is depth 0, so a leaf object nested DEPTH_LIMIT - 2 deep holds
    // its coordinate at DEPTH_LIMIT - 1, the last depth walked.
    expect(roundMetaCoordinates(nest(DEPTH_LIMIT - 2, { latitude: "37.79535" }))).toEqual(
      nest(DEPTH_LIMIT - 2, { latitude: "37.8" }),
    );
    const beyond = nest(DEPTH_LIMIT - 1, { latitude: "37.79535" });
    expect(roundMetaCoordinates(beyond)).toEqual(beyond);
  });
});
