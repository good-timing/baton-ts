/**
 * The HTTP sink against `baton-spec`'s fake collector, in every scenario of
 * `collector/scenarios.json`; what each checks is the file's `about`. Skipped
 * where `python3` is missing, which the collector needs.
 */
import { describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { makeEvent } from "./_sink.js";
import {
  hasPython,
  received,
  scenarioFile,
  scenarioSink,
  startCollector,
  type Received,
  type SinkSettings,
} from "./_scenarios.js";

interface Scenario {
  name: string;
  mode: string;
  delay_ms?: number;
  events: number;
  settings?: Partial<SinkSettings>;
  expect?: { accepted?: number; dropped?: number; reports?: number; requests?: number };
}

const spec = scenarioFile<{
  settings: SinkSettings;
  limits: { write_ms: number; close_margin_ms: number; report_ms: number };
  scenarios: Scenario[];
}>("scenarios.json");


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
      const { limits } = spec;
      const settings = { ...spec.settings, ...scenario.settings };
      const sink = scenarioSink(port, settings);
      const sent = Array.from({ length: scenario.events }, (_, i) => i + 1);
      for (const n of sent) {
        const started = performance.now();
        await sink.write(makeEvent({ sequence_number: n }));
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
      const dropped = Object.values(PROCESS_DROPS.total()).reduce((sum, n) => sum + n, 0);

      // A step that failed is one that raised somewhere unseen.
      expect(seen.filter((w) => w.includes(" failed"))).toEqual([]);
      const { accepted: got, requests, reports: reported } = await receivedBy(port, scenario.mode);
      if (scenario.mode !== "down") expect(requests).toBeGreaterThanOrEqual(1);
      expect(got.every((n) => sent.includes(n))).toBe(true);
      expect(got.length + dropped).toBeGreaterThanOrEqual(sent.length);
      if (scenario.expect?.accepted !== undefined) expect(got.length).toBe(scenario.expect.accepted);
      if (scenario.expect?.dropped !== undefined) expect(dropped).toBe(scenario.expect.dropped);
      if (reports !== undefined) expect(reported).toBe(reports);
      if (scenario.expect?.requests !== undefined) expect(requests).toBe(scenario.expect.requests);
    } finally {
      warnings.mockRestore();
    }
    // Above the report wait and close limits together, so a failure reports itself, not a timeout.
  }, 15_000);
});
