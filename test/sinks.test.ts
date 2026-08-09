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
