/**
 * Replays `baton-spec/scrub/cases.json`: inputs generated and scrubbed by
 * baton-sdk's `Scrubber`, the reference. Each must come out of this package's
 * `Scrubber` the same, with the same counts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { DEPTH_MARKER, Scrubber } from "../src/scrub.js";

interface ScrubCase {
  input: unknown;
  output: unknown;
  counts: Record<string, number>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
  readFileSync(path.join(here, "..", "baton-spec", "scrub", "cases.json"), "utf8"),
) as ScrubCase[];

function quietly<T>(run: (warnings: string[]) => T): T {
  const warnings: string[] = [];
  const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
    warnings.push(String(w));
  });
  try {
    return run(warnings);
  } finally {
    spy.mockRestore();
  }
}

describe("baton-spec scrub cases", () => {
  it("scrubs every case as baton-sdk does", () => {
    const mismatches = quietly(() =>
      cases.flatMap((c, index) => {
        const scrubber = new Scrubber();
        const output = scrubber.scrub(c.input);
        const counts = Object.fromEntries(scrubber.counts);
        if (isDeepStrictEqual({ output, counts }, { output: c.output, counts: c.counts })) return [];
        return [{ index, input: c.input, expected: c.output, output, expectedCounts: c.counts, counts }];
      }),
    );
    expect(cases.length).toBeGreaterThan(0);
    expect({ failing: mismatches.length, first: mismatches.slice(0, 10) }).toEqual({ failing: 0, first: [] });
  });

  it("adds up counts across calls on one scrubber, and warns about depth once", () => {
    const expected: Record<string, number> = {};
    for (const c of cases) {
      for (const [category, n] of Object.entries(c.counts)) expected[category] = (expected[category] ?? 0) + n;
    }
    const scrubber = new Scrubber();
    const warnings = quietly((seen) => {
      for (const c of cases) scrubber.scrub(c.input);
      return seen;
    });
    expect(Object.fromEntries(scrubber.counts)).toEqual(expected);
    expect(expected.depth_limit).toBeGreaterThan(0);
    expect(warnings.filter((w) => w.includes(DEPTH_MARKER))).toHaveLength(1);
  });
});
