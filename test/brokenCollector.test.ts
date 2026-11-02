/**
 * The HTTP sink against `baton-spec`'s fake collector, in every scenario of
 * `collector/scenarios.json`; what each checks is the file's `about`. Skipped
 * where `python3` is missing, which the collector needs.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { ToolCallStartEventSchema, type Event } from "../src/events.js";
import { HttpSink } from "../src/sinks.js";

interface Scenario {
  name: string;
  mode: string;
  delay_ms?: number;
  events: number;
  expect?: { accepted?: number; dropped?: number; reports?: number };
}

const collectorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "baton-spec", "collector");
const spec = JSON.parse(readFileSync(path.join(collectorDir, "scenarios.json"), "utf-8")) as {
  settings: { request_timeout_ms: number; shutdown_budget_ms: number; backoff_base_ms: number };
  limits: { write_ms: number; close_margin_ms: number; report_ms: number };
  scenarios: Scenario[];
};
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function makeEvent(sequence: number): Event {
  return ToolCallStartEventSchema.parse({
    tenant_id: "t",
    vendor_id: "v",
    session_id: "s",
    sequence_number: sequence,
    captured_at: new Date().toISOString(),
    consent_token: "ct",
    call_id: "call-1",
    payload: { tool_name: "lookup" },
  });
}

let running: ChildProcess | null = null;
afterEach(() => {
  running?.kill();
  running = null;
});

/** The port of a collector in the scenario's mode, or 1, where nothing
 * listens, for "down". */
async function startCollector(scenario: Scenario): Promise<number> {
  if (scenario.mode === "down") return 1;
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

interface Received {
  accepted: number[];
  requests: number;
  reports: number;
}

async function received(port: number, mode: string, query = ""): Promise<Received> {
  if (mode === "down") return { accepted: [], requests: 0, reports: 0 };
  const response = await fetch(`http://127.0.0.1:${port}/_received${query}`, { signal: AbortSignal.timeout(5000) });
  return (await response.json()) as Received;
}

describe.skipIf(!hasPython)("the HTTP sink against a broken collector", () => {
  it.each(spec.scenarios)("keeps its promises: $name", async (scenario) => {
    const seen: string[] = [];
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      seen.push(String(w));
    });
    try {
      const port = await startCollector(scenario);
      const { settings, limits } = spec;
      const sink = new HttpSink(`http://127.0.0.1:${port}`, {
        apiKey: "k",
        requestTimeoutMs: settings.request_timeout_ms,
        shutdownFlushTimeoutMs: settings.shutdown_budget_ms,
        backoffBaseMs: settings.backoff_base_ms,
      });
      const sent = Array.from({ length: scenario.events }, (_, i) => i + 1);
      for (const n of sent) {
        const started = performance.now();
        await sink.write(makeEvent(n));
        expect(performance.now() - started).toBeLessThanOrEqual(limits.write_ms);
      }
      const reports = scenario.expect?.reports;
      if (reports !== undefined) {
        const accepted = scenario.expect?.accepted ?? 0;
        await received(port, scenario.mode, `?accepted=${accepted}&reports=${reports}&wait_ms=${limits.report_ms}`);
      }
      const started = performance.now();
      await sink.aclose();
      expect(performance.now() - started).toBeLessThanOrEqual(settings.shutdown_budget_ms + limits.close_margin_ms);

      // A step that failed is one that raised somewhere unseen.
      expect(seen.filter((w) => w.includes(" failed"))).toEqual([]);
      const { accepted: got, requests, reports: reported } = await received(port, scenario.mode);
      if (scenario.mode !== "down") expect(requests).toBeGreaterThanOrEqual(1);
      const dropped = Object.values(PROCESS_DROPS.total()).reduce((sum, n) => sum + n, 0);
      expect(got.every((n) => sent.includes(n))).toBe(true);
      expect(got.length + dropped).toBeGreaterThanOrEqual(sent.length);
      if (scenario.expect?.accepted !== undefined) expect(got.length).toBe(scenario.expect.accepted);
      if (scenario.expect?.dropped !== undefined) expect(dropped).toBe(scenario.expect.dropped);
      if (reports !== undefined) expect(reported).toBe(reports);
    } finally {
      warnings.mockRestore();
    }
    // Above the report wait and close limits together, so a failure reports itself, not a timeout.
  }, 15_000);
});
