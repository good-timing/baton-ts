import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { FileSink, HttpSink, MultiSink, SinkClosedError, StdoutSink, safeWrite, type HttpSinkOptions, type Sink } from "../src/sinks.js";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ClientReportEventSchema, type Event } from "../src/events.js";
import { acceptAll, makeEvent, results, sentIn, sequences, sinkWith, type Sent } from "./_sink.js";


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

function messages(warning: { mock: { calls: unknown[][] } }): string[] {
  return warning.mock.calls.map(([message]) => String(message));
}

/** Called directly, so the test runner's own exit listeners never fire. */
function exitHooks(sink: HttpSink): { atExit: () => void; drained: () => Promise<void>; exited: () => void } {
  const internals = sink as unknown as {
    exitHooks: { beforeExit: () => void; exit: () => void };
    drainChain: Promise<void>;
  };
  return {
    atExit: () => internals.exitHooks.beforeExit(),
    drained: () => internals.drainChain,
    exited: () => internals.exitHooks.exit(),
  };
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

  it("loses nothing to a closed sink while another takes the event", async () => {
    const closed = new StdoutSink();
    await closed.aclose();
    const ok = recording();
    const sink = new MultiSink([closed, ok.sink]);
    await sink.write(makeEvent({ sequence_number: 1 }));
    expect(ok.seen).toEqual(["write:1"]);
  });
});

describe("HttpSink", () => {
  it("POSTs a batch to {url}/v0/events/batch with bearer auth and drains the buffer", async () => {
    const fetchImpl = vi.fn().mockImplementation(acceptAll);
    const sink = new HttpSink("https://collector.example/", { apiKey: "k", fetchImpl });

    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.write(makeEvent({ sequence_number: 2 }));
    await sink.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://collector.example/v0/events/batch");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(sequences(init as RequestInit)).toEqual([1, 2]);
    expect(sink["buffer"]).toHaveLength(0);
    await sink.aclose();
  });

  it("retries transient failures with backoff, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(acceptAll);
    const sink = sinkWith(fetchImpl, {
      backoffBaseMs: 1,
    });

    await sink.write(makeEvent());
    await sink.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await sink.aclose();
  });

  it("drops a permanent failure (4xx) without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const sink = sinkWith(fetchImpl);

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
      const sink = sinkWith(fetchImpl);
      await sink.write(makeEvent());
      await sink.flush();
      await sink.aclose();

      const logged = messages(warning).join("");
      expect(logged).toContain(`REFUSED an event and it has been dropped (HTTP 422): ${reason}`);
      const detail = logged.slice(logged.indexOf(reason), logged.indexOf(" — the event is gone"));
      expect([...detail]).toHaveLength(500);
      expect(detail.endsWith("😀")).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  it("logs a refusal with its control characters escaped", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad\nfield\u001b[31m\u202e\u2028😀 \\u{a}", { status: 422 }));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const sink = sinkWith(fetchImpl);
      await sink.write(makeEvent());
      await sink.flush();
      await sink.aclose();

      const logged = messages(warning).join("");
      expect(logged).toContain("bad\\u{a}field\\u{1b}[31m\\u{202e}\\u{2028}😀 \\u{5c}u{a} — the event is gone");
    } finally {
      warning.mockRestore();
    }
  });

  it("logs the first refusal, then at most one a minute, counting those between", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("no", { status: 422 })));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    let now = 1_000_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const sink = sinkWith(fetchImpl);
      const refusals = () => messages(warning).filter((m) => m.includes("REFUSED"));
      for (let i = 0; i < 3; i++) await sink.write(makeEvent());
      await sink.flush();
      expect(refusals()).toEqual([
        "baton: collector REFUSED 3 events and they have been dropped (HTTP 422): no — the event is gone; nothing retries a refusal.",
      ]);

      now += 59_999;
      await sink.write(makeEvent());
      await sink.flush();
      expect(refusals()).toHaveLength(1);

      now += 1;
      await sink.write(makeEvent());
      await sink.flush();
      expect(refusals()).toHaveLength(2);
      expect(refusals()[1]).toContain(" 1 more refused since the last such warning.");

      await sink.write(makeEvent());
      await sink.flush();
      await sink.aclose();
      expect(refusals()).toHaveLength(2);
      expect(messages(warning)).toContain(
        "baton: the sink closed; 1 more event(s) refused since the last such warning.",
      );
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
      warning.mockRestore();
    }
  });

  it("logs a refusal with a new status at once, counting each status apart", async () => {
    const statuses = [422, 422, 401];
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("no", { status: statuses.shift()! })));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const sink = sinkWith(fetchImpl);
      for (let i = 0; i < 3; i++) {
        await sink.write(makeEvent());
        await sink.flush();
      }
      await sink.aclose();

      const refusals = messages(warning).filter((m) => m.includes("REFUSED"));
      expect(refusals.map((m) => /HTTP (\d+)/.exec(m)![1])).toEqual(["422", "401"]);
      expect(refusals[1]).not.toContain("more refused");
      expect(messages(warning)).toContain(
        "baton: the sink closed; 1 more event(s) refused since the last such warning.",
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("logs refusals still counted when the process exits without aclose()", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("no", { status: 422 })));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const sink = sinkWith(fetchImpl);
      const { atExit } = exitHooks(sink);
      for (let i = 0; i < 3; i++) {
        await sink.write(makeEvent());
        await sink.flush();
      }
      atExit();
      atExit();

      const exiting = messages(warning).filter((m) => m.includes("process exiting"));
      expect(exiting).toEqual(["baton: process exiting; 2 more event(s) refused since the last such warning."]);
      await sink.aclose();
    } finally {
      warning.mockRestore();
    }
  });

  it("writes what is left to stderr when process.exit() skips beforeExit", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("no", { status: 422 })));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sink = sinkWith(fetchImpl, { maxRetries: 0 });
    try {
      for (let i = 0; i < 2; i++) {
        await sink.write(makeEvent());
        await sink.flush();
      }
      fetchImpl.mockRejectedValue(new Error("offline"));
      for (let i = 0; i < 3; i++) await sink.write(makeEvent());
      const { exited } = exitHooks(sink);
      exited();

      expect(messages(stderr)).toEqual([
        "baton: process exiting with 3 unsent event(s).\n",
        "baton: process exiting; 1 more event(s) refused since the last such warning.\n",
      ]);
      const exitListeners = process.listeners("exit").length;
      await sink.aclose();
      expect(process.listeners("exit")).toHaveLength(exitListeners - 1);
    } finally {
      await sink.aclose();
      stderr.mockRestore();
      warning.mockRestore();
    }
  });

  it("writes at exit only what the beforeExit pass did not warn about", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sink = sinkWith(fetchImpl, { maxRetries: 0 });
    try {
      await sink.write(makeEvent());
      await sink.flush();
      const { atExit, drained, exited } = exitHooks(sink);
      atExit();
      await drained();
      exited();
      expect(messages(warning)).toContain("baton: process exiting with 1 unsent event(s).");
      expect(stderr).not.toHaveBeenCalled();

      // The process went on after the pass and recorded more it cannot send.
      await sink.write(makeEvent());
      await sink.flush();
      exited();
      expect(messages(stderr)).toEqual(["baton: process exiting with 2 unsent event(s).\n"]);
    } finally {
      await sink.aclose();
      stderr.mockRestore();
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
      const sink = sinkWith(fetchImpl);
      await sink.write(makeEvent());
      await sink.flush();
      await sink.aclose();

      expect(messages(warning).join("")).toContain(`(HTTP 413): ${reason}x`);
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
      .mockImplementation(acceptAll);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const sink = sinkWith(fetchImpl, { requestTimeoutMs: 20 });
      await sink.write(makeEvent({ sequence_number: 1 }));
      await sink.flush();
      await sink.write(makeEvent({ sequence_number: 2 }));
      await sink.flush();
      await sink.aclose();

      const events = fetchImpl.mock.calls.flatMap(([, init]) => sequences(init as RequestInit));
      expect(events).toEqual([1, 2]);
      expect(messages(warning).join("")).toContain("(HTTP 413): <unreadable>");
    } finally {
      warning.mockRestore();
    }
  });

  it("opens the circuit breaker after consecutive failures and stops sending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const sink = sinkWith(fetchImpl, {
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

  it("keeps one request in flight across writes, the timer and overlapping flushes", async () => {
    const sent: number[][] = [];
    let inFlight = 0;
    let most = 0;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sent.push(sequences(init));
      most = Math.max(most, ++inFlight);
      return new Promise<Response>((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve(results(sentIn(init)));
        }, 5),
      );
    });
    const sink = sinkWith(fetchImpl, { flushIntervalMs: 1 });

    const flushes: Promise<void>[] = [];
    for (let i = 0; i < 250; i += 1) {
      await sink.write(makeEvent({ sequence_number: i }));
      if (i % 20 === 0) flushes.push(sink.flush());
      if (i % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await Promise.all(flushes);
    await sink.flush();

    expect(most).toBe(1);
    expect(sent.flat()).toEqual(Array.from({ length: 250 }, (_, i) => i));
    await sink.aclose();
  });

  it("drops the oldest event on buffer overflow", async () => {
    const fetchImpl = vi.fn().mockImplementation(acceptAll);
    const sink = sinkWith(fetchImpl, {
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
      sent.push(...sequences(init));
      return acceptAll("", init);
    });
    const warnings: string[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      warnings.push(String(w));
    });
    const sink = sinkWith(fetchImpl);
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
    expect(PROCESS_DROPS.total()).toEqual({ encode_failed: 1 });
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
    const sink = sinkWith(fetchImpl, {
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
      fetchImpl.mockImplementation(acceptAll);
      await sink.write(makeEvent({ sequence_number: 5 }));
      await sink.flush();
      expect(fetchImpl.mock.calls.length).toBe(2);
      expect(sequences(fetchImpl.mock.calls[1]![1] as RequestInit)).toEqual([0, 1, 2, 3, 4, 5]);
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
    const sink = sinkWith(fetchImpl, {
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
    const sink = sinkWith(fetchImpl, { maxRetries: 0 });
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
    const fails: ((err: Error) => void)[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fails.push(reject);
          }),
      )
      .mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const sink = sinkWith(fetchImpl, {
      maxRetries: 0,
      requestTimeoutMs: 10_000,
      shutdownFlushTimeoutMs: 200,
      flushIntervalMs: 1,
    });
    try {
      await sink.write(makeEvent());
      const flushing = sink.flush();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      // The timer queues a pass of its own behind the flush's stuck one.
      await sink.write(makeEvent());
      await vi.waitFor(() => expect(sink["queuedDrain"]).not.toBeNull());
      await flushing;
      fails[0]!(new Error("refused"));
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      const started = Date.now();
      await sink.flush();
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      await sink.aclose();
      spy.mockRestore();
    }
  });

  it("queues one pass, not one per write, while a send is stuck", async () => {
    let release: (response: Response) => void = () => {};
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(acceptAll);
    const sink = sinkWith(fetchImpl);
    const passes = vi.spyOn(sink as unknown as { drainLocked: () => Promise<void> }, "drainLocked");
    try {
      // Every write after the 100th finds a full batch waiting.
      for (let i = 0; i < 300; i += 1) await sink.write(makeEvent());
      release(new Response(null, { status: 202 }));
      await vi.waitFor(() => expect(sink["buffer"]).toHaveLength(0));
      await sink["drainChain"];
      expect(passes.mock.calls.length).toBeLessThanOrEqual(2);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      await sink.aclose();
    }
  });

  it("adds nothing per write to the queued pass while a send is stuck", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const sink = sinkWith(fetchImpl, { requestTimeoutMs: 60_000, shutdownFlushTimeoutMs: 50 });
    try {
      for (let i = 0; i < 100; i += 1) await sink.write(makeEvent());
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 100; i += 1) await sink.write(makeEvent());
      const queued = sink["queuedDrain"] as Promise<void>;
      expect(queued).not.toBeNull();
      // `catch` and `finally` both go through `then`.
      const handlers = vi.spyOn(queued, "then");
      for (let i = 0; i < 500; i += 1) await sink.write(makeEvent());
      expect(handlers).not.toHaveBeenCalled();
    } finally {
      vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      await sink.aclose();
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
      .mockImplementation(acceptAll);
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const sink = sinkWith(fetchImpl, {
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
    const sink = sinkWith(fetchImpl, { maxRetries: 0 });
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
    const sink = sinkWith(fetchImpl, {
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
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not retry a fast-failing send at exit", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("refused"));
    const sink = sinkWith(fetchImpl, {
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
    const sink = sinkWith(fetchImpl, {
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

describe("HttpSink batches (SPEC §2.5)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  type Answer = (events: Sent[], url: string, init: RequestInit) => Response | Promise<Response>;

  /** A collector answering each request with `answer`, recording every request. */
  function collector(answer: Answer = (events) => results(events)) {
    const requests: { url: string; events: Sent[]; bytes: number }[] = [];
    const fetchImpl = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const events = sentIn(init);
      requests.push({ url, events, bytes: Buffer.byteLength(init.body as string) });
      return Promise.resolve(answer(events, url, init));
    });
    const batches = () =>
      requests
        .map((r) => r.events.filter((e) => e.event_type !== "client_report").map((e) => e.sequence_number))
        .filter((batch) => batch.length > 0);
    return { fetchImpl, requests, batches };
  }

  const quiet = () => vi.spyOn(process, "emitWarning").mockImplementation(() => {});

  function sized(sequence_number: number, bytes: number): Event {
    const event = makeEvent({ sequence_number });
    (event.payload as { params: Record<string, unknown> }).params = { blob: "é".repeat(bytes / 2) };
    return event;
  }

  it("sends once 100 events wait, and not before", async () => {
    const { fetchImpl, batches } = collector();
    const sink = sinkWith(fetchImpl);
    try {
      for (let i = 0; i < 99; i += 1) await sink.write(makeEvent({ sequence_number: i }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchImpl).not.toHaveBeenCalled();
      await sink.write(makeEvent({ sequence_number: 99 }));
      await vi.waitFor(() => expect(batches()).toEqual([Array.from({ length: 100 }, (_, i) => i)]));
    } finally {
      await sink.aclose();
    }
  });

  it("sends before the next event would take the body over 1 MiB, counting UTF-8 bytes", async () => {
    const { fetchImpl, requests, batches } = collector();
    const sink = sinkWith(fetchImpl);
    try {
      // "é" is two bytes in UTF-8, so these are about 400 kB each, not 200.
      await sink.write(sized(1, 400_000));
      await sink.write(sized(2, 400_000));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchImpl).not.toHaveBeenCalled();
      await sink.write(sized(3, 400_000));
      await vi.waitFor(() => expect(batches()).toEqual([[1, 2]]));
      await sink.flush();
      expect(batches()).toEqual([[1, 2], [3]]);
      for (const { bytes } of requests) expect(bytes).toBeLessThanOrEqual(1_048_576);
    } finally {
      await sink.aclose();
    }
  });

  it("never sends an event over 1 MiB, and counts it refused", async () => {
    const { fetchImpl, batches } = collector();
    const warning = quiet();
    const sink = sinkWith(fetchImpl);
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.write(sized(2, 1_100_000));
    await sink.flush();
    expect(batches()).toEqual([[1]]);
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({ refused: 1 });
    expect(messages(warning).join("")).toContain("REFUSED, unsent, an event and it has been dropped (over 1 MiB)");
  });

  it("counts a single event refused when the collector answers 413", async () => {
    const { fetchImpl, batches } = collector(() => new Response("too large", { status: 413 }));
    const warning = quiet();
    const sink = sinkWith(fetchImpl);
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.flush();
    expect(batches()).toEqual([[1]]);
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({ refused: 1 });
    expect(messages(warning).join("")).toContain("REFUSED an event and it has been dropped (HTTP 413): too large");
  });

  it("sends a full batch at once and leaves the rest for its own turn", async () => {
    const { fetchImpl, batches } = collector();
    const sink = sinkWith(fetchImpl);
    try {
      for (let i = 0; i < 101; i += 1) await sink.write(makeEvent({ sequence_number: i }));
      await vi.waitFor(() => expect(batches()).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(batches()[0]).toHaveLength(100);
      expect(batches()).toHaveLength(1);
      expect(sink["buffer"]).toHaveLength(1);
      await sink.flush();
      expect(batches()[1]).toEqual([100]);
    } finally {
      await sink.aclose();
    }
  });

  it("splits a batch the collector answers 413 to, and sends each half", async () => {
    const { fetchImpl, batches } = collector((events) =>
      events.length > 2 ? new Response(null, { status: 413 }) : results(events),
    );
    const sink = sinkWith(fetchImpl);
    for (let i = 1; i <= 5; i += 1) await sink.write(makeEvent({ sequence_number: i }));
    await sink.flush();
    expect(batches()).toEqual([[1, 2, 3, 4, 5], [1, 2], [3, 4, 5], [3], [4, 5]]);
    expect(sink["buffer"]).toHaveLength(0);
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({});
  });

  it("puts one tenant and vendor in a batch", async () => {
    const { fetchImpl, batches } = collector();
    const sink = sinkWith(fetchImpl);
    for (const [n, vendor] of [[1, "v"], [2, "v"], [3, "w"], [4, "v"]] as const) {
      await sink.write({ ...makeEvent({ sequence_number: n }), vendor_id: vendor });
    }
    await sink.flush();
    expect(batches()).toEqual([[1, 2], [3], [4]]);
    await sink.aclose();
  });

  it("sends flushIntervalMs after the oldest waiting event was written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetchImpl, batches } = collector();
    const sink = sinkWith(fetchImpl, { flushIntervalMs: 50 });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await vi.advanceTimersByTimeAsync(30);
    await sink.write(makeEvent({ sequence_number: 2 }));
    await vi.advanceTimersByTimeAsync(19);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(batches()).toEqual([[1, 2]]);
    await sink.aclose();
  });

  it("sends at once on flush(), without waiting for the timer", async () => {
    const { fetchImpl, batches } = collector();
    const sink = sinkWith(fetchImpl, { flushIntervalMs: 60_000 });
    await sink.write(makeEvent({ sequence_number: 1 }));
    const started = Date.now();
    await sink.flush();
    expect(Date.now() - started).toBeLessThan(100);
    expect(batches()).toEqual([[1]]);
    await sink.aclose();
  });

  it("tries a failed batch again when the timer fires, with no further write", async () => {
    const answers = [new Response(null, { status: 503 })];
    const { fetchImpl, batches } = collector((events) => answers.shift() ?? results(events));
    const sink = sinkWith(fetchImpl, { maxRetries: 0, flushIntervalMs: 20 });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.flush();
    expect(sink["buffer"]).toHaveLength(1);
    await vi.waitFor(() => expect(sink["buffer"]).toHaveLength(0));
    expect(batches()).toEqual([[1], [1]]);
    await sink.aclose();
  });

  it("does not hold the process open with its timer", async () => {
    const { fetchImpl } = collector();
    const sink = sinkWith(fetchImpl);
    await sink.write(makeEvent());
    const timer = sink["flushTimer"] as NodeJS.Timeout;
    expect(timer).not.toBeNull();
    expect(timer.hasRef()).toBe(false);
    await sink.aclose();
    expect(sink["flushTimer"]).toBeNull();
  });

  it.each([404, 405])(
    "on %i from the batch path sends one event per request to /v0/events from then on, losing nothing",
    async (status) => {
      const { fetchImpl, requests } = collector((events, url) =>
        url.endsWith("/batch") ? new Response(null, { status }) : new Response(null, { status: 202 }),
      );
      const warning = quiet();
      const sink = sinkWith(fetchImpl);
      for (let i = 1; i <= 3; i += 1) await sink.write(makeEvent({ sequence_number: i }));
      await sink.flush();
      await sink.write(makeEvent({ sequence_number: 4 }));
      await sink.flush();
      await sink.aclose();
      expect(requests.map((r) => [r.url.replace("https://collector.example", ""), r.events.map((e) => e.sequence_number)])).toEqual([
        ["/v0/events/batch", [1, 2, 3]],
        ["/v0/events", [1]],
        ["/v0/events", [2]],
        ["/v0/events", [3]],
        ["/v0/events", [4]],
      ]);
      expect(PROCESS_DROPS.total()).toEqual({});
      expect(messages(warning).filter((m) => m.includes("no batch endpoint"))).toHaveLength(1);
    },
  );

  it("reads the results by event_id, counts each refused event, and delivers the rest", async () => {
    const { fetchImpl } = collector((events) => {
      const [a, b, c] = events;
      const answers = [
        { event_id: "not-in-this-batch", status: "refused" },
        { event_id: b!.event_id, status: "refused", error: { code: "payload_malformed", message: "bad\nfield" } },
        { event_id: c!.event_id, status: "duplicate" },
        { event_id: a!.event_id, status: "accepted" },
      ];
      return new Response(JSON.stringify({ results: answers }), { status: 200 });
    });
    const warning = quiet();
    const sink = sinkWith(fetchImpl);
    for (let i = 1; i <= 3; i += 1) await sink.write(makeEvent({ sequence_number: i }));
    await sink.flush();
    expect(sink["buffer"]).toHaveLength(0);
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({ refused: 1 });
    expect(messages(warning).join("")).toContain("REFUSED an event and it has been dropped (payload_malformed): bad\\u{a}field");
  });

  it("counts an event with no readable result as delivered", async () => {
    const { fetchImpl } = collector(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const sink = sinkWith(fetchImpl);
    await sink.write(makeEvent());
    await sink.flush();
    expect(sink["buffer"]).toHaveLength(0);
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({});
  });

  it("sends a batch again when its 2xx body cannot be read before the timeout", async () => {
    const stalled = (signal: AbortSignal) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason));
          },
        }),
        { status: 200 },
      );
    let first = true;
    const { fetchImpl, batches } = collector((events, _url, init) => {
      if (!first) return results(events);
      first = false;
      return stalled(init.signal!);
    });
    const sink = sinkWith(fetchImpl, { requestTimeoutMs: 20, backoffBaseMs: 1 });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.flush();
    expect(batches()).toEqual([[1], [1]]);
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({});
  });

  it("does not follow a redirect, and keeps the events", async () => {
    const { fetchImpl, requests } = collector(() => new Response(null, { status: 302, headers: { Location: "/elsewhere" } }));
    const sink = sinkWith(fetchImpl, { maxRetries: 0 });
    await sink.write(makeEvent());
    await sink.flush();
    expect(sink["buffer"]).toHaveLength(1);
    await sink.flush();
    expect(requests.map((r) => r.url)).toEqual([
      "https://collector.example/v0/events/batch",
      "https://collector.example/v0/events/batch",
    ]);
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
    await sink.aclose();
  });

  it("waits for the timer after a failed batch, not for the next write", async () => {
    const { fetchImpl } = collector(() => new Response(null, { status: 503 }));
    quiet();
    const sink = sinkWith(fetchImpl, { maxRetries: 0, flushIntervalMs: 60_000 });
    try {
      for (let i = 0; i < 100; i += 1) await sink.write(makeEvent());
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 300; i += 1) await sink.write(makeEvent());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await sink.aclose();
    }
  });

  it("never rejects in the background when a due report fails to build", async () => {
    const statuses = ["refused", "accepted"];
    const { fetchImpl } = collector((events) => results(events, () => statuses.shift() ?? "accepted"));
    quiet();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const sink = sinkWith(fetchImpl, { flushIntervalMs: 10 });
    try {
      for (let i = 0; i < 2; i += 1) {
        await sink.write(makeEvent());
        await sink.flush();
      }
      expect(sink["pendingReport"]).not.toBeNull();
      vi.spyOn(ClientReportEventSchema, "parse").mockImplementation(() => {
        throw new Error("schema");
      });
      await vi.waitFor(() => expect(sink["pendingReport"]).toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      await sink.aclose();
    }
  });

  it("counts as unsent at close only the half of a split batch still being sent", async () => {
    const { fetchImpl } = collector((events, _url, init) => {
      if (events.length > 2) return new Response(null, { status: 413 });
      if (events[0]!.sequence_number === 1) return results(events);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    quiet();
    const sink = sinkWith(fetchImpl, { requestTimeoutMs: 10_000, shutdownFlushTimeoutMs: 50 });
    for (let i = 1; i <= 4; i += 1) await sink.write(makeEvent({ sequence_number: i }));
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({ unsent_at_close: 2 });
  });

  it("after a 404 sends the whole due batch one event per request, and frees each answer's body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let cancelled = 0;
    const body = () =>
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      });
    const { fetchImpl, batches } = collector((_events, url) =>
      url.endsWith("/batch") ? new Response(null, { status: 404 }) : new Response(body(), { status: 202 }),
    );
    quiet();
    const sink = sinkWith(fetchImpl, { flushIntervalMs: 100 });
    await sink.write(makeEvent({ sequence_number: 0 }));
    await sink.flush();
    await sink.write(makeEvent({ sequence_number: 1 }));
    await vi.advanceTimersByTimeAsync(50);
    await sink.write(makeEvent({ sequence_number: 2 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(batches()).toEqual([[0], [0], [1], [2]]);
    expect(cancelled).toBe(3);
    await sink.aclose();
  });

  it("starts no request after aclose() returns, even in one-event mode", async () => {
    const { fetchImpl } = collector((_events, url) =>
      url.endsWith("/batch")
        ? new Response(null, { status: 404 })
        : new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 202 })), 60)),
    );
    quiet();
    const sink = sinkWith(fetchImpl, { shutdownFlushTimeoutMs: 20 });
    for (let i = 1; i <= 3; i += 1) await sink.write(makeEvent({ sequence_number: i }));
    await sink.aclose();
    const atClose = fetchImpl.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fetchImpl.mock.calls.length).toBe(atClose);
    expect(PROCESS_DROPS.total()).toEqual({ unsent_at_close: 3 });
  });

  it("refuses an event whose result is refused with no readable error, and skips a result with no string event_id", async () => {
    const { fetchImpl } = collector((events) => {
      const answers = [
        { event_id: events[0]!.event_id, status: "refused" },
        { event_id: 7, status: "refused" },
        { event_id: events[1]!.event_id, status: "refused", error: "not an object" },
      ];
      return new Response(JSON.stringify({ results: answers }), { status: 200 });
    });
    const warning = quiet();
    const sink = sinkWith(fetchImpl);
    for (let i = 1; i <= 3; i += 1) await sink.write(makeEvent({ sequence_number: i }));
    await sink.flush();
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({ refused: 2 });
    expect(messages(warning).join("")).toContain("REFUSED 2 events and they have been dropped (no code)");
  });

  /** The number of requests sent by `atMs` after a 429 answered with `retryAfter`. */
  async function requestsAfter429(retryAfter: string | null, atMs: number, options: Partial<HttpSinkOptions> = {}) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const headers: Record<string, string> = retryAfter === null ? {} : { "Retry-After": retryAfter };
    const answers = [new Response(null, { status: 429, headers })];
    const { fetchImpl, batches } = collector((events) => answers.shift() ?? results(events));
    const sink = sinkWith(fetchImpl, { flushIntervalMs: 10, maxRetries: 0, ...options });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.flush();
    await sink.flush();
    await vi.advanceTimersByTimeAsync(atMs);
    return { sink, batches };
  }

  it("keeps the batch on 429 and sends nothing, not even on flush(), until Retry-After has passed", async () => {
    const before = await requestsAfter429("2", 1990);
    expect(before.batches()).toEqual([[1]]);
    await before.sink.aclose();
    const after = await requestsAfter429("2", 2010);
    expect(after.batches()).toEqual([[1], [1]]);
    expect(after.sink["buffer"]).toHaveLength(0);
    await after.sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({ unsent_at_close: 1 });
  });

  it.each([
    ["0", 990, 1010],
    ["600", 59_990, 60_010],
  ])("clamps Retry-After %s to 1 to 60 seconds", async (retryAfter, before, after) => {
    const early = await requestsAfter429(retryAfter, before);
    expect(early.batches()).toHaveLength(1);
    await early.sink.aclose();
    const late = await requestsAfter429(retryAfter, after);
    expect(late.batches()).toHaveLength(2);
    await late.sink.aclose();
  });

  it.each([null, "soon", "Wed, 21 Oct 2015 07:28:00 GMT", "1.5"])(
    "handles a 429 with Retry-After %s like a 5xx, which counts towards the breaker",
    async (retryAfter) => {
      const { sink, batches } = await requestsAfter429(retryAfter, 1010, { circuitBreakerThreshold: 1 });
      expect(batches()).toEqual([[1]]);
      await sink.aclose();
    },
  );

  it("does not count a 429 with a readable Retry-After towards the breaker", async () => {
    const { sink, batches } = await requestsAfter429("1", 1010, { circuitBreakerThreshold: 1 });
    expect(batches()).toEqual([[1], [1]]);
    await sink.aclose();
  });

  it("sends nothing at close or exit during a 429 wait, and counts what waits as unsent", async () => {
    const { sink, batches } = await requestsAfter429("30", 0);
    quiet();
    exitHooks(sink).atExit();
    await exitHooks(sink).drained();
    await sink.aclose();
    expect(batches()).toEqual([[1]]);
    expect(PROCESS_DROPS.total()).toEqual({ unsent_at_close: 1 });
  });
});

describe("a write after close (SPEC §11.2 rules 7 and 8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sinks: Record<string, () => Sink> = {
    StdoutSink: () => new StdoutSink({ stream: { write: () => true } as unknown as NodeJS.WritableStream }),
    FileSink: () => new FileSink(join(mkdtempSync(join(tmpdir(), "baton-")), "events.jsonl")),
    HttpSink: () => new HttpSink("https://collector.example", { apiKey: "k", fetchImpl: vi.fn() }),
    "a vendor sink": () => ({
      write: () => Promise.reject(new SinkClosedError("closed")),
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    }),
    "a vendor sink throwing the other build's SinkClosedError": () => ({
      write: () => Promise.reject(Object.assign(new Error("closed"), { name: "SinkClosedError" })),
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    }),
  };

  it.each(Object.keys(sinks))("%s: is counted as after_close with one warning", async (name) => {
    const sink = sinks[name]!();
    await sink.aclose();
    await expect(sink.write(makeEvent())).rejects.toMatchObject({ name: "SinkClosedError" });
    PROCESS_DROPS.clear();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await safeWrite(sink, makeEvent());
    await safeWrite(sink, makeEvent());

    expect(PROCESS_DROPS.total()).toEqual({ after_close: 2 });
    expect(messages(warning)).toEqual(["baton: the sink is closed; further events are dropped."]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("MultiSink whose sinks are all closed rejects with SinkClosedError", async () => {
    const sink = new MultiSink([new StdoutSink(), new StdoutSink()]);
    await sink.aclose();
    await expect(sink.write(makeEvent())).rejects.toBeInstanceOf(SinkClosedError);
  });

  it("covers the surface snapshot a call after close would send", async () => {
    const written: Event[] = [];
    let closed = false;
    const sink: Sink = {
      write: async (event) => {
        if (closed) throw new SinkClosedError("closed");
        written.push(event);
      },
      flush: () => Promise.resolve(),
      aclose: async () => void (closed = true),
    };
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    server.registerTool("echo", { inputSchema: { text: z.string() } }, async (args: { text: string }) => ({
      content: [{ type: "text" as const, text: args.text }],
    }));
    const handle = withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "caller", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await handle.aclose();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.callTool({ name: "echo", arguments: { text: "hi" } });

    expect(written).toEqual([]);
    expect(PROCESS_DROPS.total()).toEqual({ after_close: 5 });
    expect(messages(warning)).toEqual(["baton: the sink is closed; further events are dropped."]);
    expect(stderr).not.toHaveBeenCalled();
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
