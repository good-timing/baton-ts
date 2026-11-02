/**
 * The HTTP sink against `baton-spec`'s fake collector, in every scenario of
 * `collector/scenarios.json`; what each checks is the file's `about`. Skipped
 * where `python3` is missing, which the collector needs.
 */
import { describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { ToolCallStartEventSchema, type Event } from "../src/events.js";
import { HttpSink } from "../src/sinks.js";
import { hasPython, received, scenarioFile, startCollector, type Received } from "./_scenarios.js";

interface Scenario {
  name: string;
  mode: string;
  delay_ms?: number;
  events: number;
  expect?: { accepted?: number; dropped?: number; reports?: number };
}

const spec = scenarioFile<{
  settings: { request_timeout_ms: number; shutdown_budget_ms: number; backoff_base_ms: number };
  limits: { write_ms: number; close_margin_ms: number; report_ms: number };
  scenarios: Scenario[];
}>("scenarios.json");

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

/** Mode "down" starts no collector: the sink sends to port 1, where nothing listens. */
const NOWHERE = 1;

function receivedBy(port: number, mode: string, query = ""): Promise<Received> {
  if (mode === "down") return Promise.resolve({ accepted: [], events: [], requests: 0, reports: 0 });
  return received(port, query);
}

describe.skipIf(!hasPython)("the HTTP sink against a broken collector", () => {
  it.each(spec.scenarios)("keeps its promises: $name", async (scenario) => {
    const seen: string[] = [];
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
      seen.push(String(w));
    });
    try {
      const port = scenario.mode === "down" ? NOWHERE : await startCollector(scenario.mode, scenario.delay_ms);
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
        await receivedBy(port, scenario.mode, `?accepted=${accepted}&reports=${reports}&wait_ms=${limits.report_ms}`);
      }
      const started = performance.now();
      await sink.aclose();
      expect(performance.now() - started).toBeLessThanOrEqual(settings.shutdown_budget_ms + limits.close_margin_ms);

      // A step that failed is one that raised somewhere unseen.
      expect(seen.filter((w) => w.includes(" failed"))).toEqual([]);
      const { accepted: got, requests, reports: reported } = await receivedBy(port, scenario.mode);
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
