import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { uuid7 } from "../src/uuid7.js";

// The generator never goes back in time, so every fake clock below is set
// later than the real one and later than the test before it.
const timestampOf = (id: string): number => parseInt(id.replace(/-/g, "").slice(0, 12), 16);

describe("uuid7", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is an RFC 9562 version 7 UUID", () => {
    const id = uuid7();
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
  });

  it("carries the current time in its first 48 bits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_123);
    expect(timestampOf(uuid7())).toBe(2_000_000_000_123);
  });

  it("increases strictly within one millisecond, past the counter's range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_001_000);
    const ids = Array.from({ length: 10_000 }, () => uuid7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("keeps increasing when the clock steps backwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_002_000);
    const before = uuid7();
    vi.setSystemTime(2_000_000_001_500);
    expect(uuid7() > before).toBe(true);
  });
});
