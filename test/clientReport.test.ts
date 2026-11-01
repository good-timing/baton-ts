import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { ToolCallStartEventSchema, type Event } from "../src/events.js";
import { HttpSink } from "../src/sinks.js";

function makeEvent(): Event {
  return ToolCallStartEventSchema.parse({
    tenant_id: "t",
    vendor_id: "v",
    session_id: "s",
    sequence_number: 0,
    captured_at: new Date().toISOString(),
    consent_token: "ct",
    call_id: "call-1",
    payload: { tool_name: "lookup" },
  });
}

type Body = Record<string, unknown> & { event_type: string; payload: Record<string, unknown> };

/** Answers events by a list of statuses, and reports with `reportStatus`;
 * `null` makes a report fail to connect, `"hang"` never answers it. */
function collector(eventStatuses: number[], reportStatus: number | null | "hang" = 202) {
  const statuses = eventStatuses[Symbol.iterator]();
  const state = { reports: [] as Body[], delivered: 0 };
  const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init!.body as string) as Body;
    if (body.event_type === "client_report") {
      state.reports.push(body);
      if (reportStatus === null) return Promise.reject(new TypeError("fetch failed"));
      if (reportStatus === "hang") {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(new Response(null, { status: reportStatus }));
    }
    const status = statuses.next().value as number;
    if (status === 202) state.delivered += 1;
    return Promise.resolve(new Response(null, { status }));
  };
  return { fetchImpl, state };
}

function httpSink(
  fetchImpl: typeof fetch,
  options: { shutdownFlushTimeoutMs?: number; requestTimeoutMs?: number } = {},
) {
  return new HttpSink("https://collector.example", { apiKey: "k", fetchImpl, maxRetries: 0, ...options });
}

const internals = (sink: HttpSink) =>
  sink as unknown as { reportInFlight: AbortController | null; maybeReport: (e: Event) => void };

/** Writes and flushes `n` events, letting each report that starts settle. */
async function send(sink: HttpSink, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await sink.write(makeEvent());
    await sink.flush();
    await vi.waitFor(() => expect(internals(sink).reportInFlight).toBeNull());
  }
}

function quiet() {
  const warnings: string[] = [];
  vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
    warnings.push(String(w));
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return warnings;
}

const sinkClass = HttpSink as unknown as { reportIntervalMs: number };
const interval = sinkClass.reportIntervalMs;
const noInterval = () => {
  sinkClass.reportIntervalMs = 0;
};

afterEach(() => {
  vi.restoreAllMocks();
  sinkClass.reportIntervalMs = interval;
});

describe("client_report (SPEC §11.4.7)", () => {
  it("a delivery after a loss sends the totals", async () => {
    quiet();
    const { fetchImpl, state } = collector([400, 202]);
    const sink = httpSink(fetchImpl);
    await send(sink, 2);
    expect(state.reports).toHaveLength(1);
    const [report] = state.reports;
    expect(report!.payload).toEqual({ instance_id: PROCESS_DROPS.instanceId, dropped: { refused: 1 } });
    expect(report!.session_id).toBe(PROCESS_DROPS.instanceId);
    expect([report!.tenant_id, report!.vendor_id, report!.consent_token]).toEqual(["t", "v", "ct"]);
    for (const absent of ["call_id", "principal", "client_observed", "transport_observed"]) {
      expect(report![absent] ?? null).toBeNull();
    }
    await sink.aclose();
  });

  it("a healthy run sends no report", async () => {
    const { fetchImpl, state } = collector([202, 202, 202]);
    const sink = httpSink(fetchImpl);
    await send(sink, 3);
    await sink.aclose();
    expect(state.reports).toEqual([]);
  });

  it("sends at most one report a minute", async () => {
    quiet();
    const { fetchImpl, state } = collector([400, 202, 400, 202]);
    const sink = httpSink(fetchImpl);
    await send(sink, 4);
    expect(state.reports).toHaveLength(1);
    await sink.aclose();
  });

  it("reports a new loss once the interval passed", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 202, 400, 202]);
    const sink = httpSink(fetchImpl);
    await send(sink, 5);
    expect(state.reports.map((r) => r.payload.dropped)).toEqual([{ refused: 1 }, { refused: 2 }]);
    await sink.aclose();
  });

  it.each([500, 401])("a report answered %i is not counted and is sent again", async (status) => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 202], status);
    const sink = httpSink(fetchImpl);
    await send(sink, 3);
    expect(state.reports).toHaveLength(2);
    expect(PROCESS_DROPS.total()).toEqual({ refused: 1 });
    await sink.aclose();
  });

  it.each([400, 422])("a collector that answers a report %i gets no more", async (status) => {
    const warnings = quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 400, 202], status);
    const sink = httpSink(fetchImpl);
    await send(sink, 4);
    expect(state.reports).toHaveLength(1);
    expect(PROCESS_DROPS.total()).toEqual({ refused: 2 });
    expect(warnings.filter((w) => w.includes("REFUSED"))).toHaveLength(2);
    await sink.aclose();
  });

  it("a report that cannot reach the collector costs nothing", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 202, 202], null);
    const sink = httpSink(fetchImpl);
    await send(sink, 4);
    await sink.aclose();
    expect(state.delivered).toBe(3);
    expect(PROCESS_DROPS.total()).toEqual({ refused: 1 });
  });

  it("sends one report at a time, and close aborts it", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 400, 202], "hang");
    const sink = httpSink(fetchImpl, { shutdownFlushTimeoutMs: 5000 });
    for (let i = 0; i < 4; i += 1) {
      await sink.write(makeEvent());
      await sink.flush();
    }
    expect(state.reports).toHaveLength(1);
    expect(internals(sink).reportInFlight).not.toBeNull();
    const started = performance.now();
    await sink.aclose();
    expect(performance.now() - started).toBeLessThan(1000);
    await vi.waitFor(() => expect(internals(sink).reportInFlight).toBeNull());
    expect(PROCESS_DROPS.total()).toEqual({ refused: 2 });
  });

  it("starts no report once close began", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400]);
    const sink = httpSink(fetchImpl);
    await send(sink, 1);
    await sink.aclose();
    internals(sink).maybeReport(makeEvent());
    expect(internals(sink).reportInFlight).toBeNull();
    expect(state.reports).toEqual([]);
  });

  it("a report that gets no answer times out, and the next one goes out", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 202], "hang");
    const sink = httpSink(fetchImpl, { requestTimeoutMs: 20 });
    await send(sink, 3);
    expect(state.reports).toHaveLength(2);
    await sink.aclose();
  });
});
