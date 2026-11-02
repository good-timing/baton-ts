import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import { ToolCallStartEventSchema, type Event } from "../src/events.js";
import { HttpSink } from "../src/sinks.js";
import { results, sentIn, sinkWith } from "./_sink.js";

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

/** Answers each event by a list of statuses (202 accepts, anything else is
 * refused in the results). A report sent alone is answered `reportStatus`:
 * `"refused"` refuses it in the results, `null` fails to connect, `"hang"`
 * never answers. A report riding with events is accepted. */
function collector(eventStatuses: number[], reportStatus: number | null | "hang" | "refused" = 202) {
  const statuses = eventStatuses[Symbol.iterator]();
  const state = { reports: [] as Body[], delivered: 0, requests: [] as Body[][], inFlight: 0, most: 0 };
  const answer = (init: RequestInit | undefined): Promise<Response> => {
    const events = sentIn(init) as unknown as Body[];
    state.requests.push(events);
    if (events.every((e) => e.event_type === "client_report")) {
      state.reports.push(...events);
      if (reportStatus === null) return Promise.reject(new TypeError("fetch failed"));
      if (reportStatus === "hang") {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (typeof reportStatus === "number" && reportStatus !== 202) {
        return Promise.resolve(new Response(null, { status: reportStatus }));
      }
      return Promise.resolve(results(events, () => (reportStatus === "refused" ? "refused" : "accepted")));
    }
    return Promise.resolve(
      results(events, (e) => {
        if (e.event_type === "client_report") {
          state.reports.push(e);
          return reportStatus === "refused" ? "refused" : "accepted";
        }
        if (statuses.next().value !== 202) return "refused";
        state.delivered += 1;
        return "accepted";
      }),
    );
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    state.most = Math.max(state.most, ++state.inFlight);
    try {
      return await answer(init);
    } finally {
      state.inFlight -= 1;
    }
  };
  return { fetchImpl, state };
}

function httpSink(
  fetchImpl: typeof fetch,
  options: { shutdownFlushTimeoutMs?: number; requestTimeoutMs?: number; flushIntervalMs?: number } = {},
) {
  return sinkWith(fetchImpl, { maxRetries: 0, ...options });
}

const internals = (sink: HttpSink) =>
  sink as unknown as { pendingReport: unknown; maybeReport: (e: Event) => void };

/** Writes and flushes `n` events. The second flush sends, alone, a report the
 * first one's delivery set up. */
async function send(sink: HttpSink, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await sink.write(makeEvent());
    await sink.flush();
    await sink.flush();
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

  it.each([400, 422, "refused"] as const)("a collector that answers a report %s gets no more", async (status) => {
    const warnings = quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 400, 202], status);
    const sink = httpSink(fetchImpl);
    await send(sink, 4);
    expect(state.reports).toHaveLength(1);
    expect(PROCESS_DROPS.total()).toEqual({ refused: 2 });
    await sink.aclose();
    // The second event refusal is counted, not logged; the refused report is neither.
    expect(warnings.filter((w) => w.includes("REFUSED"))).toHaveLength(1);
    expect(warnings).toContain("baton: the sink closed; 1 more event(s) refused since the last such warning.");
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

  it("rides the next batch, so it is never a request beside one", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 202]);
    const sink = httpSink(fetchImpl);
    for (let i = 0; i < 3; i += 1) {
      await sink.write(makeEvent());
      await sink.flush();
    }
    expect(state.requests.map((events) => events.map((e) => e.event_type))).toEqual([
      ["tool_call_start"],
      ["tool_call_start"],
      ["tool_call_start", "client_report"],
    ]);
    await sink.aclose();
  });

  it("goes when the timer fires if no event follows", async () => {
    quiet();
    const { fetchImpl, state } = collector([400, 202]);
    const sink = httpSink(fetchImpl, { flushIntervalMs: 20 });
    await sink.write(makeEvent());
    await sink.flush();
    await sink.write(makeEvent());
    await sink.flush();
    expect(state.reports).toEqual([]);
    await vi.waitFor(() => expect(state.reports).toHaveLength(1));
    await sink.aclose();
  });

  it("waits its turn behind no request, and close aborts it", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 202], "hang");
    const sink = httpSink(fetchImpl, { requestTimeoutMs: 10_000, shutdownFlushTimeoutMs: 100 });
    for (let i = 0; i < 2; i += 1) {
      await sink.write(makeEvent());
      await sink.flush();
    }
    void sink.flush();
    await vi.waitFor(() => expect(state.reports).toHaveLength(1));
    await sink.write(makeEvent());
    const started = performance.now();
    await sink.aclose();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(state.most).toBe(1);
    expect(state.inFlight).toBe(0);
    expect(PROCESS_DROPS.total()).toEqual({ refused: 1, unsent_at_close: 1 });
  });

  it("starts no report once close began", async () => {
    quiet();
    noInterval();
    const { fetchImpl, state } = collector([400]);
    const sink = httpSink(fetchImpl);
    await send(sink, 1);
    await sink.aclose();
    internals(sink).maybeReport(makeEvent());
    expect(internals(sink).pendingReport).toBeNull();
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
