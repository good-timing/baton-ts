import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { PROCESS_DROPS, type DropReason } from "../src/drops.js";
import type { Event } from "../src/events.js";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { FileSink, HttpSink, MultiSink, offTheCall, QueuedSink, safeWrite, SinkClosedError, StdoutSink, type Sink } from "../src/sinks.js";
import { makeEvent } from "./_sink.js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as LibraryClient } from "../src/library/client.js";

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

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const closing = queue.aclose();
      await vi.advanceTimersByTimeAsync(3000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
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

describe("what the queue holds", () => {
  it("writes the event as it was, not as the vendor later changed it", async () => {
    const seen: unknown[] = [];
    const queue = new QueuedSink({
      write: async (event) => {
        seen.push((event.payload as { params?: unknown }).params);
      },
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    });
    const params = { city: "Oslo" };
    const event = makeEvent();
    (event.payload as { params?: unknown }).params = params;
    await queue.write(event);
    params.city = "changed";
    await queue.flush();
    expect(seen).toEqual([{ city: "Oslo" }]);
  });

  it("copies as JSON: a function is left out and toJSON is used, as a sink writing JSON would", async () => {
    const seen: unknown[] = [];
    const queue = new QueuedSink({
      write: async (event) => {
        seen.push((event.payload as { params?: unknown }).params);
      },
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    });
    const event = makeEvent();
    (event.payload as { params?: unknown }).params = { run: () => 1, price: { toJSON: () => "9.99" } };
    await queue.write(event);
    await queue.flush();
    expect(seen).toEqual([{ price: "9.99" }]);
  });

  it("drops an event it cannot copy as encode_failed, warns once, and writes the next", async () => {
    const seen = warnings();
    const encodeFailed = countOf("encode_failed");
    const inner = new LoggingSink();
    const queue = new QueuedSink(inner);
    for (const n of [1, 2]) {
      const event = makeEvent({ sequence_number: n });
      (event.payload as { params?: unknown }).params = { big: BigInt(n) };
      await queue.write(event);
    }
    await queue.write(makeEvent({ sequence_number: 3 }));
    await queue.flush();
    expect(encodeFailed()).toBe(2);
    expect(inner.log).toEqual(["write 3", "flush"]);
    expect(seen.filter((w) => w.includes("could not be copied"))).toHaveLength(1);
  });
});

describe("close", () => {
  it("takes an event recorded while it writes what waits, and refuses one after", async () => {
    const inner = new LoggingSink(20);
    const queue = new QueuedSink(inner);
    await queue.write(makeEvent({ sequence_number: 1 }));
    const closing = queue.aclose();
    await sleep(5);
    await queue.write(makeEvent({ sequence_number: 2 }));
    await closing;
    expect(inner.log).toEqual(["write 1", "write 2", "close"]);
    await expect(queue.write(makeEvent())).rejects.toThrow(SinkClosedError);
  });

  it("on a queue never written to, closes the sink at once", async () => {
    const inner = new LoggingSink();
    const started = performance.now();
    await new QueuedSink(inner).aclose();
    expect(performance.now() - started).toBeLessThan(100);
    expect(inner.log).toEqual(["close"]);
  });
});

describe("the queue's writer", () => {
  it("gives the event loop a turn every 100 writes", async () => {
    const inner = new LoggingSink();
    const queue = new QueuedSink(inner);
    for (let i = 0; i < 300; i++) await queue.write(makeEvent());
    await new Promise((resolve) => setImmediate(resolve));
    expect(inner.log).toHaveLength(100);
    await queue.flush();
  });

  it("returns at once from a flush on a stuck write, even when the full queue drops events", async () => {
    warnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const queue = new QueuedSink(stuckSink());
      await queue.write(makeEvent());
      await new Promise((resolve) => setImmediate(resolve));
      void queue.flush();
      await vi.advanceTimersByTimeAsync(3000);
      for (let i = 0; i < 1005; i++) await queue.write(makeEvent());
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

  it("goes on when a warning throws, with the event it was writing counted write_failed", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {
      throw new Error("warning handler broke");
    });
    const writeFailed = countOf("write_failed");
    const written: number[] = [];
    const queue = new QueuedSink({
      write: async (event) => {
        if (event.sequence_number === 1) throw new Error("disk full");
        written.push(event.sequence_number);
      },
      flush: () => Promise.resolve(),
      aclose: () => Promise.resolve(),
    });
    await queue.write(makeEvent({ sequence_number: 1 }));
    await queue.write(makeEvent({ sequence_number: 2 }));
    await sleep(10);
    await queue.write(makeEvent({ sequence_number: 3 }));
    await queue.flush();
    expect(writeFailed()).toBe(1);
    expect(written).toEqual([2, 3]);
  });
});

describe("at process exit", () => {
  it("writes what waits to a StdoutSink on stderr at once, in one write", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const queue = new QueuedSink(new StdoutSink());
    await queue.write(makeEvent({ sequence_number: 1 }));
    await queue.write(makeEvent({ sequence_number: 2 }));
    expect(queue.handOffAtExit()).toBe(0);
    expect(writes).toHaveLength(1);
    const lines = writes[0]!.trimEnd().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as Event).sequence_number)).toEqual([1, 2]);
  });

  it("counts what waits for a StdoutSink on any other stream, which may write later", async () => {
    const lines: string[] = [];
    const stream = { write: (line: string) => lines.push(line) } as unknown as NodeJS.WritableStream;
    const queue = new QueuedSink(new StdoutSink({ stream }));
    await queue.write(makeEvent());
    await queue.write(makeEvent());
    expect(queue.handOffAtExit()).toBe(2);
    expect(lines).toEqual([]);
  });

  it("writes nothing to a sink the vendor already closed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "baton-exit-")), "events.jsonl");
    const file = new FileSink(path);
    const queue = new QueuedSink(file);
    await queue.write(makeEvent());
    await file.aclose();
    expect(queue.handOffAtExit()).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("appends what waits to a FileSink's file before it returns", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "baton-exit-")), "events.jsonl");
    const queue = new QueuedSink(new FileSink(path));
    await queue.write(makeEvent({ sequence_number: 1 }));
    await queue.write(makeEvent({ sequence_number: 2 }));
    expect(queue.handOffAtExit()).toBe(0);
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("does not start writes on another sink, and answers how many may be lost", async () => {
    const inner = new LoggingSink(10);
    const queue = new QueuedSink(inner);
    await queue.write(makeEvent());
    await queue.write(makeEvent());
    expect(queue.handOffAtExit()).toBe(2);
    await sleep(30);
    expect(inner.log).toEqual([]);
  });

  it("does not break a write when process.on throws", async () => {
    vi.resetModules();
    vi.spyOn(process, "on").mockImplementation(() => {
      throw new Error("no exit hooks here");
    });
    const fresh = await import("../src/sinks.js");
    const inner = new LoggingSink();
    const queue = new fresh.QueuedSink(inner);
    await queue.write(makeEvent({ sequence_number: 1 }));
    await queue.flush();
    expect(inner.log).toEqual(["write 1", "flush"]);
  });
});

describe("offTheCall", () => {
  it("gives one sink a new queue each time, one for each install or client", () => {
    const sink = new LoggingSink();
    const first = offTheCall(sink);
    const second = offTheCall(sink);
    expect(first).toBeInstanceOf(QueuedSink);
    expect(second).toBeInstanceOf(QueuedSink);
    expect(second).not.toBe(first);
  });

  it("leaves an HttpSink alone, which already queues", () => {
    const http = new HttpSink("https://collector.example", { apiKey: "k" });
    expect(offTheCall(http)).toBe(http);
  });

  it("leaves alone an HttpSink subclass that keeps HttpSink's write", () => {
    class OwnHttp extends HttpSink {}
    const http = new OwnHttp("https://collector.example", { apiKey: "k" });
    expect(offTheCall(http)).toBe(http);
  });

  it("queues a MultiSink, an HttpSink subclass with its own write, and the vendor's own sink, but not a queue", () => {
    class OwnWrite extends HttpSink {
      override write(event: Event): Promise<void> {
        return super.write(event);
      }
    }
    const sinks: Sink[] = [
      new MultiSink([new LoggingSink()]),
      new OwnWrite("https://collector.example", { apiKey: "k" }),
      new LoggingSink(),
    ];
    for (const sink of sinks) {
      const queued = offTheCall(sink);
      expect(queued).toBeInstanceOf(QueuedSink);
      expect(offTheCall(queued)).toBe(queued);
    }
  });
});

describe("the library Client after close", () => {
  it("warns once for events refused while its sink closes and after", async () => {
    const seen = warnings();
    vi.spyOn(process.stderr, "write").mockImplementation((line: string | Uint8Array) => {
      seen.push(String(line));
      return true;
    });
    const afterClose = countOf("after_close");
    const client = new LibraryClient({
      vendorId: "acme",
      sink: {
        write: () => Promise.resolve(),
        flush: () => Promise.resolve(),
        aclose: () => sleep(50),
      },
    });
    const closing = client.aclose();
    await sleep(20);
    client.trace({ toolName: "during" }, () => "ok");
    await closing;
    client.trace({ toolName: "after" }, () => "ok");
    await sleep(0);
    expect(afterClose()).toBeGreaterThanOrEqual(2);
    expect(seen.filter((w) => w.includes("closed"))).toHaveLength(1);
  });
});

describe("FileSink", () => {
  it("rejects, not throws, on an event it cannot encode", () => {
    const sink = new FileSink(join(mkdtempSync(join(tmpdir(), "baton-file-")), "events.jsonl"));
    const event = makeEvent();
    (event.payload as { params?: unknown }).params = { big: BigInt(1) };
    let result: Promise<void> | undefined;
    expect(() => {
      result = sink.write(event);
    }).not.toThrow();
    return expect(result).rejects.toThrow(TypeError);
  });
});

describe("the copy-failure warning", () => {
  it("names the error, not the event's content", async () => {
    const seen = warnings();
    const queue = new QueuedSink(new LoggingSink());
    const event = makeEvent();
    (event.payload as { params?: unknown }).params = { secret_key_name: BigInt(1) };
    await queue.write(event);
    const warning = seen.find((w) => w.includes("could not be copied"));
    expect(warning).toContain("TypeError");
    expect(warning).not.toContain("BigInt");
  });
});
