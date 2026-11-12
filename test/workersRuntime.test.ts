/**
 * Rules the Cloudflare Workers runtime holds a module to, that Node does not:
 * its global `fetch` throws "Illegal invocation" when called as a method, a
 * module may not make random values while it loads, and a timer or read a
 * request left behind may never run.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSink } from "../src/sinks.js";
import { SettingsFetcher } from "../src/integrations/mcp/captureSettings.js";
import { acceptAll, makeEvent } from "./_sink.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("node:crypto");
  vi.resetModules();
});

/** A global `fetch` that refuses any `this` but the global, as a Worker's does. */
function workerFetch(): ReturnType<typeof vi.fn> {
  const calls = vi.fn();
  vi.stubGlobal("fetch", function (this: unknown, input: unknown, init: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    calls(input, init);
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  return calls;
}

describe("Workers runtime rules", () => {
  it("HttpSink sends with the global fetch", async () => {
    const calls = workerFetch();
    const sink = new HttpSink("https://collector.example", { apiKey: "k" });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.flush();
    expect(calls).toHaveBeenCalledTimes(1);
    await sink.aclose();
  });

  it("the settings fetcher reads with the global fetch", async () => {
    const calls = workerFetch();
    const fetcher = new SettingsFetcher({
      origin: "https://h.example.com",
      apiKey: "baton_pk_x",
      tenantId: "ten_1",
      vendorId: "srv",
      refreshMs: 60_000,
    });
    await fetcher.readOnce();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("HttpSink sends a write at once, with no timer", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(acceptAll);
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink["drainChain"];
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await sink.aclose();
  });

  it("knows a Worker with no navigator by its WebSocketPair", async () => {
    vi.stubGlobal("WebSocketPair", function WebSocketPair() {});
    const fetchImpl = vi.fn().mockImplementation(acceptAll);
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink["drainChain"];
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await sink.aclose();
  });

  it.each([
    ["on Workers", true],
    ["with flushIntervalMs 0 off Workers", false],
  ])("holds writes back after a failed send, then a write retries %s once the backoff is over", async (_where, workers) => {
    if (workers) vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockImplementation(acceptAll);
    const sink = new HttpSink("https://collector.example", {
      apiKey: "k",
      fetchImpl,
      maxRetries: 0,
      backoffBaseMs: 1000,
      ...(workers ? {} : { flushIntervalMs: 0 }),
    });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink["drainChain"];
    await sink.write(makeEvent({ sequence_number: 2 }));
    await sink["drainChain"];
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A Worker may drop the retry timer; the next write after the backoff retries.
    vi.clearAllTimers();
    vi.setSystemTime(Date.now() + 1000);
    await sink.write(makeEvent({ sequence_number: 3 }));
    await sink["drainChain"];
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await sink.aclose();
  });

  it("leaves a write waiting for its batch off Workers", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(acceptAll);
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink["drainChain"];
    expect(fetchImpl).not.toHaveBeenCalled();
    await sink.aclose();
  });

  it("does not read Console settings, keeps the report tool, and says so where a Worker prints it", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const { resolveBatonConfig } = await import("../src/integrations/mcp/config.js");
    const config = resolveBatonConfig({ dsn: "https://baton_pk_x@h.example.com/ten_0a1b2c3d/srv", settings: "console" });
    expect(config.captureSettings).toBeUndefined();
    expect(config.reportMode).toBe("on");
    expect(warnings.mock.calls.map(([m]) => String(m))).toContainEqual(expect.stringContaining("not supported on Cloudflare Workers"));
  });

  it("still refuses Console settings without a dsn", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolveBatonConfig } = await import("../src/integrations/mcp/config.js");
    expect(() => resolveBatonConfig({ vendorId: "srv", settings: "console" })).toThrow(/needs a dsn/);
  });

  it("holds a write back until a failed batch's backoff is over, even with no timer armed", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(acceptAll);
    const sink = new HttpSink("https://collector.example", { apiKey: "k", fetchImpl });
    sink["waitForTimer"] = true;
    sink["retryFrom"] = Date.now() + 1000;
    await sink.write(makeEvent({ sequence_number: 1 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await sink["drainChain"];
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await sink.aclose();
  });

  it("loads the package without making a random value", async () => {
    vi.resetModules();
    vi.doMock("node:crypto", async (original) => ({
      ...(await original<typeof import("node:crypto")>()),
      randomBytes: () => {
        throw new Error("random value while the module loads");
      },
    }));
    await expect(import("../src/index.js")).resolves.toHaveProperty("withBaton");
  });
});
