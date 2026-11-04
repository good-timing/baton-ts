import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { PROCESS_DROPS, type DropReason } from "../src/drops.js";
import type { Event } from "../src/events.js";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { callWithin, HttpSink, MultiSink, offTheCall, QueuedSink, safeWrite, SinkClosedError, StdoutSink, type Sink } from "../src/sinks.js";
import { makeEvent } from "./_sink.js";

const never = (): Promise<void> => new Promise(() => {});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class LoggingSink implements Sink {
  readonly log: string[] = [];
  constructor(private readonly writeMs = 0) {}
  async write(event: Event): Promise<void> {
    if (this.writeMs > 0) await sleep(this.writeMs);
    this.log.push(`write ${event.sequence_number}`);
  }
  async flush(): Promise<void> {
    this.log.push("flush");
  }
  async aclose(): Promise<void> {
    this.log.push("close");
  }
}

function stuckSink(): Sink & { closed: boolean } {
  return {
    closed: false,
    write: never,
    flush: () => Promise.resolve(),
    async aclose() {
      this.closed = true;
    },
  };
}

function countOf(reason: DropReason): () => number {
  const before = PROCESS_DROPS.total()[reason] ?? 0;
  return () => (PROCESS_DROPS.total()[reason] ?? 0) - before;
}

function warnings(): string[] {
  const seen: string[] = [];
  vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
    seen.push(String(w));
  });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a sink behind Baton's queue", () => {
  it("does not slow the vendor's tool call", async () => {
    const server = new McpServer({ name: "vendor", version: "1.0.0" });
    server.registerTool("echo", { inputSchema: { text: z.string() } }, ({ text }) => ({
      content: [{ type: "text" as const, text }],
    }));
    const sink = new LoggingSink(1000);
    const handle = withBaton(server, { vendorId: "acme", consentToken: "ct", sink });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const started = performance.now();
    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(performance.now() - started).toBeLessThan(500);
    await client.close();
    await handle.aclose();
  });

  it("writes events in order, one at a time", async () => {
    const inner = new LoggingSink(5);
    const queue = new QueuedSink(inner);
    for (const n of [1, 2, 3]) await queue.write(makeEvent({ sequence_number: n }));
    await queue.flush();
    expect(inner.log).toEqual(["write 1", "write 2", "write 3", "flush"]);
  });

  it("drops the oldest event when 1000 wait, counts it buffer_full, and warns once", async () => {
    const seen = warnings();
    const bufferFull = countOf("buffer_full");
    const queue = new QueuedSink(stuckSink());
    await queue.write(makeEvent());
    await sleep(0);
    // The one being written is outside the bound.
    for (let i = 0; i < 1002; i++) await queue.write(makeEvent());
    expect(bufferFull()).toBe(2);
    expect(seen.filter((w) => w.includes("queue is full"))).toHaveLength(1);
  });

  it("counts an event the sink fails to write as write_failed, warns once, and goes on", async () => {
    const seen = warnings();
    const writeFailed = countOf("write_failed");
    const written: number[] = [];
    const queue = new QueuedSink({
      write: async (event) => {
        if (event.sequence_number < 3) throw new Error("disk full");
        written.push(event.sequence_number);
      },
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    });
    for (const n of [1, 2, 3]) await queue.write(makeEvent({ sequence_number: n }));
    await queue.flush();
    expect(writeFailed()).toBe(2);
    expect(written).toEqual([3]);
    expect(seen.filter((w) => w.includes("failed to write"))).toHaveLength(1);
  });

  it("counts a sink the vendor closed themselves as after_close, not write_failed", async () => {
    warnings();
    const afterClose = countOf("after_close");
    const writeFailed = countOf("write_failed");
    const queue = new QueuedSink({
      write: () => Promise.reject(new SinkClosedError("closed")),
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    });
    await queue.write(makeEvent());
    await queue.flush();
    expect(afterClose()).toBe(1);
    expect(writeFailed()).toBe(0);
  });

  it("flush waits for the events written before it", async () => {
    const inner = new LoggingSink(20);
    const queue = new QueuedSink(inner);
    await queue.write(makeEvent({ sequence_number: 1 }));
    await queue.write(makeEvent({ sequence_number: 2 }));
    await queue.flush();
    expect(inner.log).toEqual(["write 1", "write 2", "flush"]);
  });

  it("close writes what waits, then closes the sink", async () => {
    const inner = new LoggingSink(5);
    const queue = new QueuedSink(inner);
    await queue.write(makeEvent({ sequence_number: 1 }));
    await queue.write(makeEvent({ sequence_number: 2 }));
    await queue.aclose();
    expect(inner.log).toEqual(["write 1", "write 2", "close"]);
  });

  it("close that runs out of time counts what is left as unsent_at_close and still closes the sink", async () => {
    const seen = warnings();
    const unsent = countOf("unsent_at_close");
    const inner = stuckSink();
    const queue = new QueuedSink(inner);
    for (let i = 0; i < 3; i++) await queue.write(makeEvent());

    const started = performance.now();
    await callWithin(queue, "aclose", 100);
    expect(performance.now() - started).toBeLessThan(500);
    expect(unsent()).toBe(3);
    expect(inner.closed).toBe(true);
    expect(seen.filter((w) => w.includes("3 event(s) not yet written"))).toHaveLength(1);
  });

  it("a second close waits for the first", async () => {
    let closed = false;
    const queue = new QueuedSink({
      write: () => Promise.resolve(),
      flush: () => Promise.resolve(),
      aclose: async () => {
        await sleep(30);
        closed = true;
      },
    });
    void queue.aclose();
    await queue.aclose();
    expect(closed).toBe(true);
  });

  it("refuses an event after close, which safeWrite counts as after_close", async () => {
    warnings();
    const afterClose = countOf("after_close");
    const queue = new QueuedSink(new LoggingSink());
    await queue.aclose();
    await expect(queue.write(makeEvent())).rejects.toThrow(SinkClosedError);
    await safeWrite(queue, makeEvent());
    expect(afterClose()).toBe(1);
  });

  it("returns at once from a flush while an earlier flush found the write stuck", async () => {
    warnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const queue = new QueuedSink(stuckSink());
      await queue.write(makeEvent());
      void queue.flush();
      await vi.advanceTimersByTimeAsync(3000);
      let done = false;
      void queue.flush().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("at process exit", () => {
  it("hands a StdoutSink what waits, which it writes at once", async () => {
    const lines: string[] = [];
    const stream = { write: (line: string) => lines.push(line) } as unknown as NodeJS.WritableStream;
    const queue = new QueuedSink(new StdoutSink({ stream }));
    await queue.write(makeEvent({ sequence_number: 1 }));
    await queue.write(makeEvent({ sequence_number: 2 }));
    expect(queue.handOffAtExit()).toBe(0);
    expect(lines.map((line) => (JSON.parse(line) as Event).sequence_number)).toEqual([1, 2]);
  });

  it("answers how many events another sink may not have written", async () => {
    const queue = new QueuedSink(new LoggingSink(10));
    await queue.write(makeEvent());
    await queue.write(makeEvent());
    expect(queue.handOffAtExit()).toBe(2);
  });
});

describe("offTheCall", () => {
  it("gives a sink one queue, and a new one after that queue closed", async () => {
    const sink = new LoggingSink();
    const first = offTheCall(sink);
    expect(offTheCall(sink)).toBe(first);
    await first.aclose();
    expect(offTheCall(sink)).not.toBe(first);
  });

  it("leaves an HttpSink alone, which already queues", () => {
    const http = new HttpSink("https://collector.example", { apiKey: "k" });
    expect(offTheCall(http)).toBe(http);
  });

  it("queues a MultiSink, a subclass of HttpSink, and the vendor's own sink, once", () => {
    class OwnHttp extends HttpSink {}
    const sinks: Sink[] = [
      new MultiSink([new LoggingSink()]),
      new OwnHttp("https://collector.example", { apiKey: "k" }),
      new LoggingSink(),
    ];
    for (const sink of sinks) {
      const queued = offTheCall(sink);
      expect(queued).toBeInstanceOf(QueuedSink);
      expect(offTheCall(queued)).toBe(queued);
    }
  });
});
