/**
 * `withBaton`'s shutdown against `baton-spec`'s fake collector, in every
 * scenario of `collector/shutdown.json`; what each checks is the file's
 * `about`. Skipped where `python3` is missing, which the collector needs.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { HttpSink } from "../src/sinks.js";

type Step =
  | { call: number }
  | { flush: object }
  | { close: object }
  | { close_twice: object }
  | { check: { tool_events: number } };

interface Scenario {
  name: string;
  mode: string;
  delay_ms?: number;
  steps: Step[];
  expect: { dropped: Record<string, number>; warnings_after_close?: number };
}

const collectorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "baton-spec", "collector");
const spec = JSON.parse(readFileSync(path.join(collectorDir, "shutdown.json"), "utf-8")) as {
  settings: { request_timeout_ms: number; shutdown_budget_ms: number; backoff_base_ms: number };
  limits: { call_ms: number; close_margin_ms: number };
  scenarios: Scenario[];
};
const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** Scenarios this SDK does not run, with the reason. */
const NOT_RUN: Record<string, string> = {};

let running: ChildProcess | null = null;
afterEach(() => {
  running?.kill();
  running = null;
  vi.restoreAllMocks();
});

async function startCollector(scenario: Scenario): Promise<number> {
  const child = spawn(
    "python3",
    [path.join(collectorDir, "fake_collector.py"), "--mode", scenario.mode, "--delay-ms", String(scenario.delay_ms ?? 0)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  running = child;
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    lines.once("line", (line) => resolve(Number(line)));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the fake collector exited (${String(code)}) before printing its port`)));
  });
}

async function toolEvents(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/_received`, { signal: AbortSignal.timeout(5000) });
  const { events } = (await response.json()) as { events: { event_type: string }[] };
  return events.filter((e) => e.event_type === "tool_call_start" || e.event_type === "tool_call_end").length;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shutdown-runner", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function within<T>(limitMs: number, what: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  return run().then((value) => {
    expect(performance.now() - started, `${what} took too long`).toBeLessThanOrEqual(limitMs);
    return value;
  });
}

describe.skipIf(!hasPython)("withBaton's shutdown against the fake collector", () => {
  it.each(spec.scenarios.filter((s) => !(s.name in NOT_RUN)))(
    "keeps SPEC §11.2 rule 7: $name",
    async (scenario) => {
      let afterClose = false;
      let warnings = 0;
      vi.spyOn(process, "emitWarning").mockImplementation(() => {
        if (afterClose) warnings += 1;
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => {
        if (afterClose) warnings += 1;
        return true;
      });

      const port = await startCollector(scenario);
      const { settings, limits } = spec;
      const sink = new HttpSink(`http://127.0.0.1:${port}`, {
        apiKey: "k",
        requestTimeoutMs: settings.request_timeout_ms,
        shutdownFlushTimeoutMs: settings.shutdown_budget_ms,
        backoffBaseMs: settings.backoff_base_ms,
      });
      const server = new McpServer({ name: "vendor", version: "1.0.0" });
      server.registerTool("echo", { inputSchema: { text: z.string() } }, async (args: { text: string }) => ({
        content: [{ type: "text" as const, text: args.text }],
      }));
      const handle = withBaton(server, { vendorId: "acme", vendorDisplayName: "Acme", consentToken: "ct", sink });
      const client = await connect(server);
      const closeLimit = settings.shutdown_budget_ms + limits.close_margin_ms;
      const close = async () => {
        await within(closeLimit, "close", () => handle.aclose());
        afterClose = true;
      };

      const stillClosing: Promise<void>[] = [];
      for (const step of scenario.steps) {
        if ("call" in step) {
          for (let i = 0; i < step.call; i += 1) {
            const result = await within(limits.call_ms, "a call", () =>
              client.callTool({ name: "echo", arguments: { text: `hi ${i}` } }),
            );
            expect(result.content).toEqual([{ type: "text", text: `hi ${i}` }]);
          }
        } else if ("flush" in step) {
          await within(closeLimit, "flush", () => handle.flush());
        } else if ("close" in step) {
          await close();
        } else if ("close_twice" in step) {
          stillClosing.push(close());
          await close();
        } else {
          expect(await toolEvents(port)).toBe(step.check.tool_events);
        }
      }

      await Promise.all(stillClosing);
      const grew = Object.fromEntries(Object.entries(PROCESS_DROPS.total()).filter(([, n]) => n > 0));
      expect(Object.keys(grew).sort()).toEqual(Object.keys(scenario.expect.dropped).sort());
      for (const [reason, least] of Object.entries(scenario.expect.dropped)) {
        expect(grew[reason], reason).toBeGreaterThanOrEqual(least);
      }
      if (scenario.expect.warnings_after_close !== undefined) {
        expect(warnings).toBe(scenario.expect.warnings_after_close);
      }
    },
    // Above two closes at their limit, so a failure reports itself, not a timeout.
    15_000,
  );
});
