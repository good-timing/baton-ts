/**
 * `withBaton`'s shutdown against `baton-spec`'s fake collector, in every
 * scenario of `collector/shutdown.json`; what each checks is the file's
 * `about`. Skipped where `python3` is missing, which the collector needs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { withBaton } from "../src/integrations/mcp/withBaton.js";
import { CFG } from "./integrations/mcp/_majors.js";
import {
  connectInMemory,
  echoServer,
  hasPython,
  scenarioFile,
  scenarioSink,
  startCollector,
  toolEvents,
  type SinkSettings,
} from "./_scenarios.js";

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
  settings?: Partial<SinkSettings>;
  steps: Step[];
  expect: { dropped: Record<string, number>; warnings_after_close?: number };
}

const spec = scenarioFile<{
  settings: SinkSettings;
  limits: { call_ms: number; close_margin_ms: number };
  scenarios: Scenario[];
}>("shutdown.json");

/** Scenarios this SDK does not run, with the reason. */
const NOT_RUN: Record<string, string> = {};

afterEach(() => {
  vi.restoreAllMocks();
});

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

      const port = await startCollector(scenario.mode, scenario.delay_ms);
      const { limits } = spec;
      const settings = { ...spec.settings, ...scenario.settings };
      const sink = scenarioSink(port, settings);
      const server = echoServer();
      const handle = withBaton(server, { ...CFG, sink });
      const client = await connectInMemory(server);
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
          const both = [close(), close()];
          stillClosing.push(...both);
          await Promise.race(both);
        } else {
          expect(await toolEvents(port)).toHaveLength(step.check.tool_events);
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
