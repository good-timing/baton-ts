import { describe, expect, it, vi } from "vitest";
import { raceDeadline, TIMED_OUT } from "../src/deadline.js";
import { boundedSinkCall, HttpSink } from "../src/sinks.js";
import { Client, type Sink } from "../src/index.js";

function collectWarnings(): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
    seen.push(String(w));
  });
  return { seen, restore: () => spy.mockRestore() };
}

function sinkWith(overrides: Partial<Record<keyof Sink, unknown>>): Sink {
  return {
    write: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    aclose: () => Promise.resolve(),
    ...overrides,
  } as Sink;
}

describe("boundedSinkCall (SPEC §11.2 rule 7)", () => {
  it("returns within the default budget from a close that never settles", async () => {
    const warnings = collectWarnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done = false;
      const call = boundedSinkCall(sinkWith({ aclose: () => new Promise(() => {}) }), "aclose").then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(3249);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(warnings.seen.some((w) => w.includes("left unfinished"))).toBe(true);
    } finally {
      vi.useRealTimers();
      warnings.restore();
    }
  });

  it("never rejects, whether the sink rejects, throws, or returns no promise", async () => {
    const warnings = collectWarnings();
    try {
      await boundedSinkCall(sinkWith({ flush: () => Promise.reject(new Error("disk full")) }), "flush");
      await boundedSinkCall(
        sinkWith({
          aclose: () => {
            throw new Error("sync throw");
          },
        }),
        "aclose",
      );
      // A vendor's sink written with plain methods returns no promise.
      await boundedSinkCall(sinkWith({ flush: () => undefined }), "flush");
      // An object with no prototype has no `toString`, so `String()` throws on it.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      await boundedSinkCall(sinkWith({ flush: () => Promise.reject(Object.create(null)) }), "flush");
      expect(warnings.seen.filter((w) => w.includes("failed"))).toHaveLength(3);
    } finally {
      warnings.restore();
    }
  });

  it("waits as long as an HttpSink's own budget", async () => {
    class SlowFlush extends HttpSink {
      override flush(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done = false;
      const sink = new SlowFlush("https://collector.example", { apiKey: "k", shutdownFlushTimeoutMs: 10_000 });
      const call = boundedSinkCall(sink, "flush").then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([Infinity, 2 ** 31, Number.NaN, -1, "5000"])(
    "replaces a shutdownFlushTimeoutMs of %s with 3000",
    (budget) => {
      const warnings = collectWarnings();
      try {
        const sink = new HttpSink("https://collector.example", {
          apiKey: "k",
          shutdownFlushTimeoutMs: budget as number,
        });
        expect(sink["shutdownFlushTimeoutMs"]).toBe(3000);
        expect(warnings.seen.some((w) => w.includes("shutdownFlushTimeoutMs"))).toBe(true);
      } finally {
        warnings.restore();
      }
    },
  );

  it("keeps a shutdownFlushTimeoutMs of 0, which means do not wait", () => {
    const sink = new HttpSink("https://collector.example", { apiKey: "k", shutdownFlushTimeoutMs: 0 });
    expect(sink["shutdownFlushTimeoutMs"]).toBe(0);
  });

  it("never rejects when reading an HttpSink's budget throws", async () => {
    const sink = new Proxy(new HttpSink("https://collector.example", { apiKey: "k" }), {
      get(target, key, receiver) {
        if (key === "shutdownFlushTimeoutMs") throw new Error("boom");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    await expect(boundedSinkCall(sink, "flush")).resolves.toBeUndefined();
  });
});

describe("raceDeadline", () => {
  it("does not fire at once for a wait past Node's timer limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let result: unknown = "pending";
      void raceDeadline(new Promise(() => {}), 2 ** 31 + 250).then((r) => {
        result = r;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(2 ** 31);
      expect(result).toBe(TIMED_OUT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Client.aclose() on a sink of the vendor's own (SPEC §11.2 rule 7)", () => {
  it("returns from a sink that never answers", async () => {
    const stuck = sinkWith({ flush: () => new Promise(() => {}), aclose: () => new Promise(() => {}) });
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

  it("closes the sink when a write fails with an error that cannot be printed", async () => {
    let closed = false;
    const sink = sinkWith({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      write: () => Promise.reject(Object.create(null)),
      aclose: () => {
        closed = true;
        return Promise.resolve();
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const client = new Client({ sink, vendorId: "acme" });
      client.trace({ toolName: "t" }, () => "ok");
      await client.aclose();
      expect(closed).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("closes the sink even when in-flight events never settle", async () => {
    let closed = false;
    const sink = sinkWith({
      write: () => new Promise(() => {}),
      aclose: () => {
        closed = true;
        return Promise.resolve();
      },
    });
    const warnings = collectWarnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const client = new Client({ sink, vendorId: "acme" });
      void client.trace({ toolName: "t" }, () => "ok");
      const done = client.aclose();
      await vi.advanceTimersByTimeAsync(2000);
      await done;
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      warnings.restore();
    }
  });
});
