import { describe, expect, it, vi } from "vitest";
import { boundedSinkCall } from "../src/deadline.js";
import { Client, type Sink } from "../src/index.js";

function collectWarnings(): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
    seen.push(String(w));
  });
  return { seen, restore: () => spy.mockRestore() };
}

describe("boundedSinkCall (SPEC §11.2 rule 7)", () => {
  it("returns within its budget from work that never settles", async () => {
    const warnings = collectWarnings();
    try {
      const started = Date.now();
      await boundedSinkCall(() => new Promise(() => {}), "aclose()", 50);
      expect(Date.now() - started).toBeLessThan(500);
      expect(warnings.seen.some((w) => w.includes("left unfinished"))).toBe(true);
    } finally {
      warnings.restore();
    }
  });

  it("never rejects, whether the work throws or rejects", async () => {
    const warnings = collectWarnings();
    try {
      await boundedSinkCall(() => Promise.reject(new Error("disk full")), "flush()");
      await boundedSinkCall(() => {
        throw new Error("sync throw");
      }, "aclose()");
      expect(warnings.seen.filter((w) => w.includes("failed"))).toHaveLength(2);
    } finally {
      warnings.restore();
    }
  });

  it("bounds a library Client's close on a sink of the vendor's own that never answers", async () => {
    const stuck: Sink = {
      write: () => Promise.resolve(),
      flush: () => new Promise(() => {}),
      aclose: () => new Promise(() => {}),
    };
    const warnings = collectWarnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const client = new Client({ sink: stuck, vendorId: "acme" });
      const closed = client.aclose();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      warnings.restore();
    }
  });
});
