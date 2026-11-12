/**
 * Rules the Cloudflare Workers runtime holds a module to, that Node does not:
 * its global `fetch` throws "Illegal invocation" when called as a method, and
 * a module may not make random values while it loads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSink } from "../src/sinks.js";
import { SettingsFetcher } from "../src/integrations/mcp/captureSettings.js";
import { makeEvent } from "./_sink.js";

afterEach(() => {
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

describe("on the Workers runtime", () => {
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
