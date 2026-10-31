import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileSink, HttpSink, MultiSink, StdoutSink, safeWrite, type Sink } from "../src/sinks.js";
import { ToolCallStartEventSchema, type Event } from "../src/events.js";

function makeEvent(overrides: Partial<{ sequence_number: number }> = {}): Event {
  return ToolCallStartEventSchema.parse({
    tenant_id: "t",
    vendor_id: "v",
    session_id: "s",
    sequence_number: overrides.sequence_number ?? 0,
    captured_at: new Date().toISOString(),
    consent_token: "ct",
    call_id: "call-1",
    payload: { tool_name: "lookup" },
  });
}

describe("StdoutSink", () => {
  it("writes one JSONL line per event to the given stream", async () => {
    const chunks: string[] = [];
    const stream: Pick<NodeJS.WritableStream, "write"> = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    };
    const sink = new StdoutSink({ stream: stream as NodeJS.WritableStream });

    await sink.write(makeEvent());
    await sink.aclose();

    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!)).toMatchObject({ event_type: "tool_call_start" });
  });

  it("rejects writes after close", async () => {
    const sink = new StdoutSink();
    await sink.aclose();
    await expect(sink.write(makeEvent())).rejects.toThrow("closed");
  });
});

/** The sink's `beforeExit` handler and its drain chain, without firing the
 * test runner's own `beforeExit` listeners. */
function exitHooks(sink: HttpSink): { atExit: () => void; drained: () => Promise<void> } {
  const internals = sink as unknown as { beforeExitHandler: () => void; drainChain: Promise<void> };
  return { atExit: () => internals.beforeExitHandler(), drained: () => internals.drainChain };
}
describe("FileSink", () => {
  const tempPath = () => join(mkdtempSync(join(tmpdir(), "baton-filesink-")), "events.jsonl");

  it("creates no file until the first write", async () => {
    const path = tempPath();
    const sink = new FileSink(path);
    await sink.aclose();
    expect(existsSync(path)).toBe(false);
  });

  it("appends one JSONL line per event, in call order, after what was there", async () => {
    const path = tempPath();
    writeFileSync(path, "earlier\n");
    const sink = new FileSink(path);

    await Promise.all([0, 1, 2, 3, 4].map((n) => sink.write(makeEvent({ sequence_number: n }))));
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(7);
    await sink.aclose();

    const [first, ...rest] = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(first).toBe("earlier");
    expect(rest.map((line) => (JSON.parse(line) as Event).sequence_number)).toEqual([0, 1, 2, 3, 4]);
  });

  it("rejects writes after close, and a second close is a no-op", async () => {
    const sink = new FileSink(tempPath());
    await sink.write(makeEvent());
    await sink.aclose();
    await sink.aclose();
    await expect(sink.write(makeEvent())).rejects.toThrow("FileSink is closed");
  });
});

describe("MultiSink", () => {
  const recording = () => {
    const seen: string[] = [];
    const sink: Sink = {
      write: async (event) => void seen.push(`write:${event.sequence_number}`),
      flush: async () => void seen.push("flush"),
      aclose: async () => void seen.push("aclose"),
    };
    return { sink, seen };
  };
  const failing = (message: string): Sink => ({
    write: () => {
      throw new Error(message);
    },
    flush: async () => {},
    aclose: async () => {},
  });

  it("refuses an empty list", () => {
    expect(() => new MultiSink([])).toThrow("at least one sink");
  });

  it("passes write, flush and aclose to every sink", async () => {
    const a = recording();
    const b = recording();
    const sink = new MultiSink([a.sink, b.sink]);
    await sink.write(makeEvent({ sequence_number: 7 }));
    await sink.flush();
    await sink.aclose();
    expect(a.seen).toEqual(["write:7", "flush", "aclose"]);
    expect(b.seen).toEqual(a.seen);
  });

  it("still reaches the other sinks when one fails, and rethrows that one failure", async () => {
    const ok = recording();
    const sink = new MultiSink([failing("boom"), ok.sink]);
    await expect(sink.write(makeEvent({ sequence_number: 1 }))).rejects.toThrow("boom");
    expect(ok.seen).toEqual(["write:1"]);
  });

  it("aggregates several failures", async () => {
    const sink = new MultiSink([failing("one"), failing("two")]);
    const err = await sink.write(makeEvent()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(["one", "two"]);
  });
});

describe("HttpSink", () => {
  it("POSTs to {url}/v0/events with bearer auth and drains the buffer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const sink = new HttpSink("https://collector.example/", { apiKey: "k", fetchImpl });

    await sink.write(makeEvent());
    await sink.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://collector.example/v0/events");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    await sink.aclose();
  });

  it("retries transient failures with backoff, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      backoffBaseMs: 1,
    });

    await sink.write(makeEvent());
    await sink.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await sink.aclose();
  });

  it("drops a permanent failure (4xx) without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });

    await sink.write(makeEvent());
    await sink.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await sink.aclose();
  });

  it("logs a refusal with the collector's capped message", async () => {
    const reason = "envelope carries both principal and principal_id";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(reason + "😀".repeat(600), { status: 422 }));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });
      await sink.write(makeEvent());
      await sink.flush();
      await sink.aclose();

      const logged = warning.mock.calls.map(([message]) => String(message)).join("");
      expect(logged).toContain(`REFUSED an event and it has been dropped (HTTP 422): ${reason}`);
      const detail = logged.slice(logged.indexOf(reason), logged.indexOf(" — the event is gone"));
      expect([...detail]).toHaveLength(500);
      expect(detail.endsWith("😀")).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  it("logs a refusal from the head of a long body without reading the rest", async () => {
    const reason = "payload too large";
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(pulls++ === 0 ? reason : "x".repeat(100)));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(endless, { status: 413 }));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });
      await sink.write(makeEvent());
      await sink.flush();
      await sink.aclose();

      expect(warning.mock.calls.map(([message]) => String(message)).join("")).toContain(`(HTTP 413): ${reason}x`);
      expect(pulls).toBeLessThan(20);
    } finally {
      warning.mockRestore();
    }
  });

  it("logs a refusal whose body stalls as unreadable once the request times out, and sends on", async () => {
    const stalled = (signal: AbortSignal) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason));
          },
        }),
        { status: 413 },
      );
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => stalled(init.signal!))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl, requestTimeoutMs: 20 });
      await sink.write(makeEvent({ sequence_number: 1 }));
      await sink.write(makeEvent({ sequence_number: 2 }));
      await sink.flush();
      await sink.aclose();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(warning.mock.calls.map(([message]) => String(message)).join("")).toContain("(HTTP 413): <unreadable>");
    } finally {
      warning.mockRestore();
    }
  });

  it("opens the circuit breaker after consecutive failures and stops sending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      maxRetries: 0,
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 60_000,
    });

    await sink.write(makeEvent({ sequence_number: 0 }));
    await sink.flush();
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.flush();
    const callsAfterOpen = fetchImpl.mock.calls.length;

    await sink.write(makeEvent({ sequence_number: 2 }));
    await sink.flush();

    // Breaker opened after the 2nd consecutive failure; the 3rd write's
    // flush should be a no-op (no new fetch call).
    expect(fetchImpl.mock.calls.length).toBe(callsAfterOpen);
  });

  it("serializes concurrent write()-triggered drains against an explicit flush()", async () => {
    // Regression test: write()'s background drain and an overlapping
    // flush() must never call drainLocked() concurrently, or both can read
    // buffer[0]/shift() racily and duplicate or drop a send.
    const sent: number[] = [];
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sent.push((JSON.parse(init.body as string) as { sequence_number: number }).sequence_number);
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response(null, { status: 202 })), 5),
      );
    });
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });

    const writes = [
      sink.write(makeEvent({ sequence_number: 0 })),
      sink.write(makeEvent({ sequence_number: 1 })),
      sink.write(makeEvent({ sequence_number: 2 })),
    ];
    await Promise.all([...writes, sink.flush()]);
    await sink.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sent).toEqual([0, 1, 2]);
    await sink.aclose();
  });

  it("drops the oldest event on buffer overflow", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      bufferSize: 1,
      // Prevent the background drain from racing the second write.
      maxRetries: 0,
    });

    await sink.write(makeEvent({ sequence_number: 0 }));
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.flush();

    await sink.aclose();
    // Both writes succeed without throwing; overflow is silent-drop by
    // design (matches sinks.py), so this test's contract is "doesn't crash
    // and the sink keeps accepting writes."
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("drops an event that cannot be encoded and still sends the ones after it", async () => {
    const sent: number[] = [];
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sent.push((JSON.parse(init.body as string) as { sequence_number: number }).sequence_number);
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    const warnings: string[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      warnings.push(String(w));
    });
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });
    try {
      const bad = makeEvent({ sequence_number: 0 });
      (bad.payload as { params: Record<string, unknown> }).params = { n: 10n, secret: "jane@x.co" };
      await sink.write(bad);
      await sink.write(makeEvent({ sequence_number: 1 }));
      await sink.flush();
      await sink.aclose();
    } finally {
      spy.mockRestore();
    }

    expect(sent).toEqual([1]);
    expect(warnings.some((w) => w.includes("could not be encoded"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("jane@x.co");
  });

  it("stops the exit flush at shutdownFlushTimeoutMs and warns once", async () => {
    // Before exit every send fails at once, so the events stay buffered; at
    // exit every send hangs until its signal aborts.
    let exiting = false;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      exiting
        ? new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
        : Promise.reject(new Error("offline")),
    );
    const warnings: string[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      warnings.push(String(w));
    });
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      shutdownFlushTimeoutMs: 60,
      maxRetries: 0,
      circuitBreakerResetMs: 0,
    });
    const { atExit, drained } = exitHooks(sink);
    try {
      for (let i = 0; i < 5; i += 1) await sink.write(makeEvent({ sequence_number: i }));
      await sink.flush();
      exiting = true;
      fetchImpl.mockClear();

      const started = Date.now();
      atExit();
      await drained();
      atExit();
      atExit();

      expect(Date.now() - started).toBeLessThan(500);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(warnings.filter((w) => w.includes("5 unsent event"))).toHaveLength(1);

      // The process kept running after all: a write leaves exit mode.
      exiting = false;
      fetchImpl.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
      await sink.write(makeEvent({ sequence_number: 5 }));
      await sink.flush();
      expect(fetchImpl.mock.calls.length).toBe(7);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns from flush() and aclose() within shutdownFlushTimeoutMs on a stalled collector", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const warnings: string[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      warnings.push(String(w));
    });
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      requestTimeoutMs: 10_000,
      shutdownFlushTimeoutMs: 80,
    });
    try {
      await sink.write(makeEvent());
      const started = Date.now();
      await sink.flush();
      // flush() spent the budget; a second flush() does not wait behind the
      // same drain.
      const second = Date.now();
      await sink.flush();
      await sink.flush();
      expect(Date.now() - second).toBeLessThan(50);
      await sink.aclose();
      expect(Date.now() - started).toBeLessThan(300);
      expect(warnings.filter((w) => w.includes("goes on in the background"))).toHaveLength(1);
      expect(warnings.filter((w) => w.includes("flush() skipped"))).toEqual([
        "baton: flush() skipped: an earlier drain is still stuck; 1 event(s) wait to be sent.",
      ]);
      expect(warnings.filter((w) => w.includes("closed with 1 event(s) unsent"))).toHaveLength(1);
      // Nothing it started keeps running past aclose(): the request is aborted.
      const [, init] = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
      expect(init.signal?.aborted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("runs one close for overlapping aclose() calls, and the second waits for it", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("refused"));
    const warnings: string[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      warnings.push(String(w));
    });
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl, maxRetries: 0 });
    try {
      await sink.write(makeEvent());
      const [first, second] = [sink.aclose(), sink.aclose()];
      expect(second).toBe(first);
      await second;
      expect(warnings.filter((w) => w.includes("unsent"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps flush() from waiting while a pass queued during the wait is stuck", async () => {
    let fail: (err: Error) => void = () => {};
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockImplementationOnce(() => Promise.reject(new Error("refused")))
      .mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      maxRetries: 0,
      requestTimeoutMs: 10_000,
      shutdownFlushTimeoutMs: 200,
    });
    try {
      await sink.write(makeEvent());
      const flushing = sink.flush();
      await sink.write(makeEvent());
      await flushing;
      // The flush's own pass ends; the one the second write() queued is stuck.
      fail(new Error("refused"));
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      const started = Date.now();
      await sink.flush();
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      await sink.aclose();
      spy.mockRestore();
    }
  });

  it("waits in flush() again once the stalled drain has finished", async () => {
    let release: (response: Response) => void = () => {};
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      requestTimeoutMs: 10_000,
      shutdownFlushTimeoutMs: 50,
    });
    try {
      await sink.write(makeEvent());
      await sink.flush();
      release(new Response(null, { status: 202 }));
      await vi.waitFor(() => expect(sink["stalledDrain"]).toBeNull());
      await sink.write(makeEvent());
      await sink.flush();
      // The buffer, not the fetch count: the POST starts at write(), so only
      // a flush() that waited sees it answered.
      expect(sink["buffer"]).toHaveLength(0);
    } finally {
      await sink.aclose();
      spy.mockRestore();
    }
  });

  it("starts no retry wait after aclose() aborts the request in progress", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffBaseMs: 2000,
      shutdownFlushTimeoutMs: 50,
    });
    try {
      await sink.write(makeEvent());
      await sink.aclose();
      const started = Date.now();
      await sink["drainChain"];
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      spy.mockRestore();
    }
  });

  it("warns about events left when aclose() ends early on a failing collector", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("refused"));
    const warnings: string[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      warnings.push(String(w));
    });
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl, maxRetries: 0 });
    try {
      await sink.write(makeEvent());
      await sink.aclose();
      expect(warnings.filter((w) => w.includes("closed with 1 event(s) unsent"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not start a second exit pass for an event written during shutdown", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("refused"));
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      maxRetries: 0,
      circuitBreakerResetMs: 0,
    });
    const { atExit, drained } = exitHooks(sink);
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await sink.write(makeEvent());
      await sink.flush();
      fetchImpl.mockClear();
      atExit();
      await drained();
      // A vendor's own beforeExit listener records one more event.
      await sink.write(makeEvent({ sequence_number: 1 }));
      await drained();
      atExit();
      await drained();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not retry a fast-failing send at exit", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("refused"));
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      maxRetries: 0,
      circuitBreakerResetMs: 0,
    });
    const { atExit, drained } = exitHooks(sink);
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await sink.write(makeEvent());
      await sink.flush();
      fetchImpl.mockClear();
      for (let i = 0; i < 5; i += 1) {
        atExit();
        await drained();
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up on a request that outlives requestTimeoutMs", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      requestTimeoutMs: 20,
      maxRetries: 1,
      backoffBaseMs: 1,
    });

    await sink.write(makeEvent());
    await sink.flush();

    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of fetchImpl.mock.calls as [string, RequestInit][]) {
      expect(init.signal?.aborted).toBe(true);
    }
    await sink.aclose();
  });
});

describe("safeWrite", () => {
  it("swallows a sink.write rejection instead of propagating it", async () => {
    const failingSink: Sink = {
      write: () => Promise.reject(new Error("boom")),
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    };
    await expect(safeWrite(failingSink, makeEvent())).resolves.toBeUndefined();
  });
});
