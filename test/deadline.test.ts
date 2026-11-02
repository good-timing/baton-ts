import { describe, expect, it, vi } from "vitest";
import { raceDeadline, TIMED_OUT } from "../src/deadline.js";
import { boundedSinkCall, callWithin, HttpSink, MultiSink } from "../src/sinks.js";
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

  it("waits as long as the longest budget inside a MultiSink", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done = false;
      const http = new HttpSink("https://collector.example", { apiKey: "k", shutdownFlushTimeoutMs: 10_000 });
      vi.spyOn(http, "flush").mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 5000)));
      const call = boundedSinkCall(new MultiSink([sinkWith({}), http]), "flush").then(() => {
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

  it.each(["flush", "aclose"] as const)(
    "%s() waits for stuck writes within the sink's budget, not on top of it",
    async (method) => {
      const called: string[] = [];
      const stuck = sinkWith({
        write: () => new Promise(() => {}),
        flush: () => (called.push("flush"), new Promise(() => {})),
        aclose: () => (called.push("aclose"), new Promise(() => {})),
      });
      const warnings = collectWarnings();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const client = new Client({ sink: stuck, vendorId: "acme" });
        void client.trace({ toolName: "t" }, () => "ok");
        let done = false;
        void client[method]().then(() => {
          done = true;
        });
        await vi.advanceTimersByTimeAsync(3249);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
        expect(called).toEqual([method]);
      } finally {
        vi.useRealTimers();
        warnings.restore();
      }
    },
  );

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
      await vi.advanceTimersByTimeAsync(3250);
      await done;
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      warnings.restore();
    }
  });
});

class HttpSinkSubclass extends HttpSink {}

function stalledHttpSink(shutdownFlushTimeoutMs: number, Kind: typeof HttpSink = HttpSink): HttpSink {
  const fetchImpl = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  return new Kind("https://collector.example", {
    apiKey: "k",
    fetchImpl,
    requestTimeoutMs: 600_000,
    shutdownFlushTimeoutMs,
  });
}

describe("one shutdown deadline, handed down (SPEC §11.2 rule 7)", () => {
  it.each([false, true])("callWithin gives our sinks the time left (wrapped: %s)", async (wrap) => {
    const warnings = collectWarnings();
    try {
      const http = stalledHttpSink(600_000);
      await http.write({} as never);
      const started = Date.now();
      await callWithin(wrap ? new MultiSink([http]) : http, "aclose", 50);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(warnings.seen.filter((w) => w.includes("closed with 1 event(s) unsent"))).toHaveLength(1);
    } finally {
      warnings.restore();
    }
  });

  it.each(["flush", "aclose"] as const)("callWithin never extends a sink's own budget (%s)", async (method) => {
    const warnings = collectWarnings();
    try {
      const http = stalledHttpSink(50);
      await http.write({} as never);
      const started = Date.now();
      await callWithin(http, method, 600_000);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      warnings.restore();
    }
  });

  it("callWithin calls a subclass's own aclose() without the time left", async () => {
    const args: unknown[][] = [];
    class OwnClose extends HttpSink {
      override aclose(...rest: unknown[]): Promise<void> {
        args.push(rest);
        return Promise.resolve();
      }
    }
    await callWithin(new OwnClose("https://collector.example", { apiKey: "k" }), "aclose", 50);
    expect(args).toEqual([[]]);
  });

  it.each([
    ["aclose", "the sink closed with", HttpSink],
    ["flush", null, HttpSink],
    ["aclose", "the sink closed with", HttpSinkSubclass],
  ] as const)("Client.%s() hands the sink what a stuck write left of the budget (%s, %o)", async (method, expected, Kind) => {
    const warnings = collectWarnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const sink = new MultiSink([sinkWith({ write: () => new Promise(() => {}) }), stalledHttpSink(3000, Kind)]);
      const client = new Client({ sink, vendorId: "acme" });
      void client.trace({ toolName: "t" }, () => "ok");
      void client[method]();
      await vi.advanceTimersByTimeAsync(3250);
      if (expected !== null) expect(warnings.seen.filter((w) => w.includes(expected))).toHaveLength(1);
      expect(warnings.seen.filter((w) => w.includes("left unfinished"))).toEqual([]);
    } finally {
      vi.useRealTimers();
      warnings.restore();
    }
  });
});

function slowHttpSink(answerMs: number, shutdownFlushTimeoutMs: number): { sink: HttpSink; sent: () => number } {
  let sent = 0;
  const fetchImpl = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve) =>
      setTimeout(() => {
        sent += (JSON.parse(init!.body as string) as { events: unknown[] }).events.length;
        resolve(new Response(null, { status: 202 }));
      }, answerMs),
    );
  const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl, shutdownFlushTimeoutMs });
  return { sink, sent: () => sent };
}

describe("one shutdown deadline: what still gets delivered", () => {
  it("delivers both events when a vendor write is slow but finishes", async () => {
    const http = slowHttpSink(20, 1000);
    const slow = sinkWith({ write: () => new Promise<void>((resolve) => setTimeout(resolve, 100)) });
    const client = new Client({ sink: new MultiSink([slow, http.sink]), vendorId: "acme" });
    client.trace({ toolName: "t" }, () => "ok");
    await client.aclose();
    expect(http.sent()).toBe(2);
  });

  it("aclose() gives a drain that an earlier flush() gave up on the time left", async () => {
    const warnings = collectWarnings();
    try {
      const http = slowHttpSink(150, 100);
      await http.sink.write({} as never);
      await http.sink.flush();
      expect(http.sent()).toBe(0);
      await http.sink.aclose();
      expect(http.sent()).toBe(1);
      expect(warnings.seen.filter((w) => w.includes("unsent"))).toEqual([]);
    } finally {
      warnings.restore();
    }
  });

  it("a flush with little time left does not mark a healthy drain stuck", async () => {
    const warnings = collectWarnings();
    try {
      const http = slowHttpSink(50, 1000);
      await http.sink.write({} as never);
      await callWithin(http.sink, "flush", 5);
      await http.sink.write({} as never);
      await http.sink.flush();
      expect(http.sent()).toBe(2);
      expect(warnings.seen.filter((w) => w.includes("skipped"))).toEqual([]);
    } finally {
      warnings.restore();
    }
  });

  it("waits on a stuck write once, not in every later flush()", async () => {
    const warnings = collectWarnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const client = new Client({ sink: sinkWith({ write: () => new Promise(() => {}) }), vendorId: "acme" });
      void client.trace({ toolName: "t" }, () => "ok");
      void client.flush();
      await vi.advanceTimersByTimeAsync(3250);
      let done = false;
      void client.flush().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      warnings.restore();
    }
  });
});
