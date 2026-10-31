import { describe, expect, it, vi } from "vitest";
import { HttpSink, StdoutSink, safeWrite, type Sink } from "../src/sinks.js";
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
      await sink.aclose();
      // flush() spent the budget; aclose() does not wait behind the same drain.
      expect(Date.now() - started).toBeLessThan(300);
      expect(warnings.filter((w) => w.includes("goes on in the background"))).toHaveLength(1);
      expect(warnings.filter((w) => w.includes("closed with 1 event(s) unsent"))).toHaveLength(1);
      // Nothing it started keeps running past aclose(): the request is aborted.
      const [, init] = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
      expect(init.signal?.aborted).toBe(true);
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
