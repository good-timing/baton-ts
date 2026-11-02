import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_DROPS } from "../src/drops.js";
import type { Event } from "../src/events.js";
import { HttpSink } from "../src/sinks.js";
import { makeEvent, results, sentIn, sinkWith } from "./_sink.js";


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

  it("a collector that refuses a report as malformed gets no more", async () => {
    const warnings = quiet();
    noInterval();
    const { fetchImpl, state } = collector([400, 202, 400, 202], "refused");
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

type Reply = (events: Body[]) => Response | Promise<Response>;
type Hanging = (init?: RequestInit) => Promise<Response>;

/** A request that is never answered; it ends only when the sink aborts it. */
const hang: Hanging = (init) =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

const each = (status: (e: Body) => string, code = "payload_malformed"): Reply => (events) =>
  new Response(
    JSON.stringify({
      results: events.map((e) => {
        const s = status(e);
        return { event_id: e.event_id, status: s, ...(s === "refused" ? { error: { code, message: "no" } } : {}) };
      }),
    }),
    { status: 200 },
  );
const acceptEach = each(() => "accepted");
const refuseEach = each(() => "refused");
const status = (code: number): Reply => () => new Response(null, { status: code });

/** Answers request i with `replies[i]`, then accepts everything. */
function scripted(replies: Reply[]) {
  const requests: { url: string; types: string[] }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const events = sentIn(init) as unknown as Body[];
    requests.push({ url: url instanceof Request ? url.url : url.toString(), types: events.map((e) => e.event_type) });
    return (replies[requests.length - 1] ?? acceptEach)(events);
  };
  const withReport = () => requests.flatMap((r, i) => (r.types.includes("client_report") ? [i] : []));
  return { fetchImpl, requests, withReport };
}

async function sendEach(sink: HttpSink, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await sink.write(makeEvent());
    await sink.flush();
  }
}

describe("what stops loss reports (SPEC §11.4.7)", () => {
  // Request 0 loses an event, request 1 delivers one and sets up a report,
  // and request 2 carries that report beside an event.
  const lossThenReport = (third: Reply): Reply[] => [refuseEach, acceptEach, third];

  it.each([400, 422])("a whole-batch %i does not stop them; another event may have caused it", async (code) => {
    quiet();
    noInterval();
    const { fetchImpl, requests, withReport } = scripted(lossThenReport(status(code)));
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 5);
    expect(requests[2]!.types).toEqual(["tool_call_start", "client_report"]);
    expect(withReport()).toEqual([2, 4]);
    await sink.aclose();
  });

  it("a refused result with another code does not stop them", async () => {
    quiet();
    noInterval();
    const quota = each((e) => (e.event_type === "client_report" ? "refused" : "accepted"), "quota_exhausted");
    const { fetchImpl, withReport } = scripted(lossThenReport(quota));
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 4);
    expect(withReport()).toEqual([2, 3]);
    await sink.aclose();
  });

  it("a refused result with payload_malformed stops them", async () => {
    quiet();
    noInterval();
    const malformed = each((e) => (e.event_type === "client_report" ? "refused" : "accepted"));
    const { fetchImpl, withReport } = scripted([refuseEach, acceptEach, malformed, refuseEach]);
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 6);
    expect(withReport()).toEqual([2]);
    await sink.aclose();
  });

  it.each([400, 422])("a %i to a report sent alone, one event per request, stops them", async (code) => {
    quiet();
    noInterval();
    // 404 on the batch path; then e1 refused, e2 delivered, e3 delivered, the report refused.
    const { fetchImpl, requests, withReport } = scripted([status(404), status(400), status(202), status(202), status(code)]);
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 3);
    expect(requests[4]!.types).toEqual(["client_report"]);
    await sink.write(makeEvent());
    await sink.flush();
    await sendEach(sink, 3);
    expect(withReport()).toEqual([4]);
    expect(requests.every((r, i) => i === 0 || r.url.endsWith("/v0/events"))).toBe(true);
    await sink.aclose();
  });

  it.each([
    ["500", status(500)],
    ["302", status(302)],
    ["429", status(429)],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
  ] as [string, Reply][])("a batch kept after %s keeps its report", async (_name, failure) => {
    quiet();
    noInterval();
    const { fetchImpl, requests } = scripted(lossThenReport(failure));
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 3);
    expect(requests[2]!.types).toEqual(["tool_call_start", "client_report"]);
    await sink.flush();
    expect(requests[3]!.types).toEqual(["tool_call_start", "client_report"]);
    await sink.aclose();
  });

  it("takes one of a full batch's places, so batches full of events still carry it", async () => {
    quiet();
    noInterval();
    const { fetchImpl, requests } = scripted([refuseEach, acceptEach]);
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 2);
    for (let i = 0; i < 200; i += 1) await sink.write(makeEvent());
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(4));
    const sizes = requests.slice(2, 4).map((r) => [r.types.length, r.types.includes("client_report")]);
    expect(sizes).toEqual([[100, true], [100, false]]);
    await sink.aclose();
  });

  it("keeps room for itself in a batch full by bytes", async () => {
    quiet();
    noInterval();
    const bodies: number[] = [];
    const { fetchImpl: inner, requests } = scripted([refuseEach, acceptEach]);
    const fetchImpl = (url: string | URL | Request, init?: RequestInit) => {
      bodies.push(Buffer.byteLength(init!.body as string));
      return inner(url, init);
    };
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 2);
    const padded = (pad: number) =>
      ({ ...makeEvent(), payload: { tool_name: "lookup", params: { pad: "x".repeat(pad) } } }) as unknown as Event;
    // Four events leave 8 bytes under 1 MiB in a batch: '{"events":[' + 4 events + 3 commas + ']}'.
    const big = padded(262_138 - JSON.stringify(padded(0)).length);
    for (let i = 0; i < 12; i += 1) await sink.write(big);
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(4));
    expect(requests[2]!.types).toContain("client_report");
    expect(Math.max(...bodies)).toBeLessThanOrEqual(1_048_576);
    await sink.aclose();
  });

  it("goes at its due time with the events waiting, without spinning the timer", async () => {
    quiet();
    noInterval();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { fetchImpl, requests } = scripted([refuseEach, acceptEach]);
      const sink = httpSink(fetchImpl, { flushIntervalMs: 5000 });
      await sendEach(sink, 2);
      await vi.advanceTimersByTimeAsync(3000);
      await sink.write(makeEvent());
      const passes = vi.spyOn(HttpSink.prototype as unknown as { drainLocked: () => Promise<void> }, "drainLocked");
      await vi.advanceTimersByTimeAsync(2000);
      expect(requests.slice(2).map((r) => r.types)).toEqual([["tool_call_start", "client_report"]]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(passes.mock.calls.length).toBeLessThan(5);
      passes.mockRestore();
      await sink.aclose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send another tenant's events early, nor build a report it cannot send", async () => {
    quiet();
    noInterval();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const builds = vi.spyOn(HttpSink.prototype as unknown as { buildReport: () => unknown }, "buildReport");
      const { fetchImpl, requests } = scripted([refuseEach, acceptEach]);
      const sink = httpSink(fetchImpl, { flushIntervalMs: 5000 });
      await sendEach(sink, 2);
      await vi.advanceTimersByTimeAsync(3000);
      await sink.write({ ...makeEvent(), vendor_id: "w" });
      const passes = vi.spyOn(HttpSink.prototype as unknown as { drainLocked: () => Promise<void> }, "drainLocked");
      await vi.advanceTimersByTimeAsync(4900);
      expect(requests).toHaveLength(2);
      expect(passes.mock.calls.length).toBeLessThan(5);
      passes.mockRestore();
      await vi.advanceTimersByTimeAsync(100);
      expect(requests.slice(2).map((r) => r.types)).toEqual([["tool_call_start"], ["client_report"]]);
      expect(builds).toHaveBeenCalledTimes(1);
      await sink.aclose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["500", () => Promise.resolve(new Response(null, { status: 500 }))],
    ["no answer", hang],
  ] as [string, Hanging][])("a lone report that fails (%s) is dropped, so it does not pause events", async (_name, failure) => {
    quiet();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // One event per request: e1 refused, e2 delivered, then every lone report fails.
      const answers: Reply[] = [status(404), status(400), status(202)];
      const requests: string[][] = [];
      const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const types = (sentIn(init) as unknown as Body[]).map((e) => e.event_type);
        requests.push(types);
        const scriptedReply = answers[requests.length - 1];
        if (scriptedReply) return scriptedReply([]);
        return types.includes("client_report") ? failure(init) : new Response(null, { status: 202 });
      };
      const sink = httpSink(fetchImpl, { flushIntervalMs: 5000, requestTimeoutMs: 100 });
      await sendEach(sink, 2);
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await sendEach(sink, 10);
      const sentEvents = requests.slice(3).filter((r) => r[0] !== "client_report");
      expect(sentEvents).toHaveLength(10);
      expect(requests.filter((r) => r[0] === "client_report")).toHaveLength(1);
      expect((sink as unknown as { circuit: { canRequest: () => boolean } }).circuit.canRequest()).toBe(true);
      await sink.aclose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("one event per request, a report taken beside an event is still alone, and dropped when it fails", async () => {
    quiet();
    const requests: string[][] = [];
    const answers = [404, 400, 202];
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const types = (sentIn(init) as unknown as Body[]).map((e) => e.event_type);
      requests.push(types);
      const code = answers[requests.length - 1] ?? (types.includes("client_report") ? 500 : 202);
      return Promise.resolve(new Response(null, { status: code }));
    };
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 5);
    expect(requests.filter((r) => r[0] === "client_report")).toHaveLength(1);
    await sink.aclose();
  });

  it("a report sent alone after a 404 on the batch path is dropped when it fails", async () => {
    quiet();
    const requests: string[][] = [];
    const fetchImpl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const types = (sentIn(init) as unknown as Body[]).map((e) => e.event_type);
      requests.push(types);
      const batchPath = (url instanceof Request ? url.url : url.toString()).endsWith("/batch");
      const code = batchPath ? 404 : types.includes("client_report") ? 500 : 202;
      return Promise.resolve(new Response(null, { status: code }));
    };
    const sink = httpSink(fetchImpl);
    PROCESS_DROPS.add("refused");
    internals(sink).maybeReport(makeEvent());
    await sendEach(sink, 3);
    expect(requests[0]).toEqual(["tool_call_start", "client_report"]);
    expect(requests.slice(1).filter((r) => r[0] === "client_report")).toHaveLength(1);
    await sink.aclose();
  });

  it("a report taken into a batch with no events is dropped when it fails", async () => {
    quiet();
    const { fetchImpl, requests } = scripted([refuseEach, acceptEach, status(500)]);
    const sink = httpSink(fetchImpl);
    await send(sink, 4);
    expect(requests[2]!.types).toEqual(["client_report"]);
    expect(requests.filter((r) => r.types.includes("client_report"))).toHaveLength(1);
    await sink.aclose();
  });

  it("a report that rode with events is kept when its batch is", async () => {
    quiet();
    const { fetchImpl, requests } = scripted([refuseEach, acceptEach, status(500)]);
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 3);
    await sink.flush();
    expect(requests.slice(2).map((r) => r.types)).toEqual([
      ["tool_call_start", "client_report"],
      ["tool_call_start", "client_report"],
    ]);
    await sink.aclose();
  });

  it("an answer that lands after close does not count its events again", async () => {
    quiet();
    let answer = (): void => {};
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const events = sentIn(init) as unknown as Body[];
      return new Promise((resolve) => {
        answer = () => resolve(refuseEach(events));
      });
    };
    const sink = httpSink(fetchImpl, { shutdownFlushTimeoutMs: 50, requestTimeoutMs: 10_000 });
    await sink.write(makeEvent());
    await sink.aclose();
    expect(PROCESS_DROPS.total()).toEqual({ unsent_at_close: 1 });
    answer();
    await new Promise((r) => setTimeout(r, 20));
    expect(PROCESS_DROPS.total()).toEqual({ unsent_at_close: 1 });
  });

  it("rides the first batch with room, not only the last in the queue", async () => {
    quiet();
    noInterval();
    const { fetchImpl, requests } = scripted([refuseEach, acceptEach]);
    const sink = httpSink(fetchImpl);
    await sendEach(sink, 2);
    await sink.write(makeEvent());
    await sink.write({ ...makeEvent(), vendor_id: "w" });
    await sink.flush();
    expect(requests.slice(2).map((r) => r.types)).toEqual([["tool_call_start", "client_report"], ["tool_call_start"]]);
    await sink.aclose();
  });
});
