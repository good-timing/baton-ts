/**
 * Rules the Cloudflare Workers runtime holds a module to, that Node does not:
 * its global `fetch` throws "Illegal invocation" when called as a method, a
 * module may not make random values while it loads, and a timer or read a
 * request left behind may never run. Its test runner may also give a
 * `process` with no `stderr` or `on`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSink, QueuedSink, safeWrite, StdoutSink } from "../src/sinks.js";
import { SettingsFetcher } from "../src/integrations/mcp/captureSettings.js";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { stderrLine, warn } from "../src/warn.js";
import type { BatonConfig } from "../src/integrations/mcp/config.js";
import { lowLevelServerOf, MAJORS } from "./integrations/mcp/_majors.js";
import { acceptAll, failingSink, makeEvent, messages, sinkWith } from "./_sink.js";
import { DisabledSink } from "../src/optout.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

/** One session on a low-level Server, with `process` replaced by `{ env: {} }`
 * from before `withBaton` on: list the tools, call one, close and flush. */
async function underBareProcess(config: BatonConfig): Promise<{ tools: { name: string }[]; result: { isError?: unknown } }> {
  const major = MAJORS[0]!;
  const { server, listTools, callTool } = lowLevelServerOf(major);
  server.setRequestHandler(listTools, async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }));
  server.setRequestHandler(callTool, async () => ({ content: [{ type: "text", text: "ok" }] }));
  vi.stubGlobal("process", { env: {} });
  const baton = withBaton(server, config);
  const client = await major.connect(server);
  const { tools } = await client.listTools();
  const result = await client.callTool({ name: "lookup", arguments: { user_goal: "1: test; success is ok" } });
  await client.close();
  await baton.flush();
  return { tools, result };
}


/** A stand-in `process` whose `on` takes the events `takes` accepts and throws for the rest. */
function processTaking(takes: (event: string) => boolean): { asked: string[]; taken: string[] } {
  const asked: string[] = [];
  const taken: string[] = [];
  vi.stubGlobal("process", {
    env: {},
    on: (event: string) => {
      asked.push(event);
      if (!takes(event)) throw new Error(`no ${event} here`);
      taken.push(event);
    },
    off: (event: string) => {
      const at = taken.indexOf(event);
      if (at !== -1) taken.splice(at, 1);
    },
  });
  return { asked, taken };
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
    expect(messages(warnings)).toContainEqual(expect.stringContaining("not supported on Cloudflare Workers"));
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

  it("serves tools/list and tool calls, and sends their events, when `process` is a bare stand-in", async () => {
    const posts = workerFetch();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tools, result } = await underBareProcess({ dsn: "https://baton_pk_x@h.example.com/ten_0a1b2c3d/srv", reportMode: "on" });
    expect(tools.map((tool) => tool.name)).toContain("lookup");
    expect(result.isError).toBeFalsy();
    expect(posts).toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it("reports a failing sink where `process` is a bare stand-in, and the tool call still answers", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await underBareProcess({ vendorId: "srv", sink: failingSink() });
    expect(result.isError).toBeFalsy();
    expect(messages(warnings)).toContainEqual(expect.stringContaining("the sink failed to write"));
  });

  it("writes events to console.warn where `process` has no stderr and no sink was given", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    await underBareProcess({ vendorId: "srv" });
    expect(messages(warnings)).toContainEqual(expect.stringContaining('"event_type":"tool_call_start"'));
  });

  it("safeWrite reports a sink's failure where `process` is a bare stand-in, without throwing", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("process", { env: {} });
    await expect(safeWrite(failingSink(), makeEvent({ sequence_number: 1 }))).resolves.toBeUndefined();
    expect(messages(warnings)).toContainEqual(expect.stringContaining("sink.write failed"));
  });

  it("stderrLine falls back to console.warn when stderr throws", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("process", { env: {}, stderr: { write: () => { throw new Error("ended"); } } });
    expect(() => stderrLine("baton: hello")).not.toThrow();
    expect(messages(warnings)).toEqual(["baton: hello"]);
  });

  it("HttpSink takes its exit hooks off the real `process` when a stand-in was swapped in after they went on", async () => {
    const real = process;
    const listeners = (): number[] => [real.listenerCount("beforeExit"), real.listenerCount("exit")];
    const before = listeners();
    const sink = sinkWith(vi.fn().mockImplementation(acceptAll));
    await sink.write(makeEvent({ sequence_number: 1 }));
    expect(listeners()).toEqual(before.map((count) => count + 1));
    vi.stubGlobal("process", { env: {} });
    await expect(sink.aclose()).resolves.toBeUndefined();
    expect(listeners()).toEqual(before);
  });

  it.each([
    ["refused it", { env: {} }],
    ["took it", { env: {}, on: () => {}, off: () => {} }],
  ])("hooks the exit hand-off on the real `process` after a stand-in %s", async (_case, standIn) => {
    vi.resetModules();
    const { QueuedSink: FreshQueuedSink } = await import("../src/sinks.js");
    const real = process;
    const before = real.listeners("exit");
    vi.stubGlobal("process", standIn);
    await new FreshQueuedSink(new DisabledSink()).write(makeEvent());
    vi.unstubAllGlobals();
    await new FreshQueuedSink(new DisabledSink()).write(makeEvent());
    await new FreshQueuedSink(new DisabledSink()).write(makeEvent());
    const added = real.listeners("exit").filter((listener) => !before.includes(listener));
    for (const listener of added) real.off("exit", listener);
    expect(added).toHaveLength(1);
  });

  it.each(["beforeExit", "exit"])("HttpSink leaves no exit hook behind where `process` takes only %s, and asks once", async (takes) => {
    const standIn = processTaking((event) => event === takes);
    const sink = sinkWith(vi.fn().mockImplementation(acceptAll));
    await sink.write(makeEvent({ sequence_number: 1 }));
    await sink.write(makeEvent({ sequence_number: 2 }));
    expect(standIn.taken).toEqual([]);
    expect(standIn.asked).toEqual(["beforeExit", "exit"]);
    await sink.aclose();
  });

  it("hooks the exit hand-off where `process` refused HttpSink's beforeExit", async () => {
    vi.resetModules();
    const { HttpSink: FreshHttpSink, QueuedSink: FreshQueuedSink } = await import("../src/sinks.js");
    const standIn = processTaking((event) => event === "exit");
    const sink = new FreshHttpSink("https://collector.example", { apiKey: "k", fetchImpl: vi.fn().mockImplementation(acceptAll) });
    await sink.write(makeEvent({ sequence_number: 1 }));
    expect(standIn.taken).toEqual([]);
    await new FreshQueuedSink(new DisabledSink()).write(makeEvent());
    expect(standIn.taken).toEqual(["exit"]);
    await sink.aclose();
  });

  it("asks a refusing `process` once for the exit hand-off", async () => {
    vi.resetModules();
    const { QueuedSink: FreshQueuedSink } = await import("../src/sinks.js");
    const standIn = processTaking(() => false);
    await new FreshQueuedSink(new DisabledSink()).write(makeEvent());
    await new FreshQueuedSink(new DisabledSink()).write(makeEvent());
    expect(standIn.asked).toEqual(["exit"]);
  });

  it("HttpSink closes where a stand-in `process` takes exit hooks but cannot take them off", async () => {
    vi.stubGlobal("process", { env: {}, on: () => {} });
    const sink = sinkWith(vi.fn().mockImplementation(acceptAll));
    await sink.write(makeEvent({ sequence_number: 1 }));
    await expect(sink.aclose()).resolves.toBeUndefined();
  });

  it("warn falls back where a stand-in `process.emitWarning` throws", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("process", { env: {}, emitWarning: () => { throw new Error("broken"); } });
    expect(() => warn("baton: hello")).not.toThrow();
    expect(messages(warnings)).toEqual(["baton: hello"]);
  });

  it("a default StdoutSink writes through console.warn where `process.stderr` cannot write, at once and at exit", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("process", { env: {}, stderr: {} });
    await new StdoutSink().write(makeEvent({ sequence_number: 1 }));
    const queue = new QueuedSink(new StdoutSink());
    await queue.write(makeEvent({ sequence_number: 2 }));
    await queue.write(makeEvent({ sequence_number: 3 }));
    expect(queue.handOffAtExit()).toBe(0);
    expect(messages(warnings).map((line) => (JSON.parse(line) as { sequence_number: number }).sequence_number)).toEqual([1, 2, 3]);
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
