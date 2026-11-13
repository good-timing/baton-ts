/** What the HttpSink tests share: an event, a sink against a mock fetch, and readers for what it sent. */
import { ToolCallStartEventSchema, type Event } from "../src/events.js";
import { HttpSink, type HttpSinkOptions, type Sink } from "../src/sinks.js";

export type Sent = { event_id?: string; event_type: string; sequence_number: number };

export function sinkWith(fetchImpl: typeof fetch, options: Partial<HttpSinkOptions> = {}): HttpSink {
  return new HttpSink("https://collector.example", { apiKey: "k", fetchImpl, ...options });
}

/** The events in one request, a batch or a single event. */
export function sentIn(init: RequestInit | undefined): Sent[] {
  const body = JSON.parse(init!.body as string) as { events?: Sent[] } & Sent;
  return body.events ?? [body];
}

/** The sequence numbers of the events in one request, leaving out loss reports. */
export function sequences(init: RequestInit | undefined): number[] {
  return sentIn(init)
    .filter((e) => e.event_type !== "client_report")
    .map((e) => e.sequence_number);
}

/** A batch answer (SPEC §2.5): `status(event)` for each event, `accepted` by default. */
export function results<T extends object>(
  events: T[],
  status: (event: T) => string = () => "accepted",
): Response {
  const answers = events.map((e) => {
    const s = status(e);
    return { event_id: (e as { event_id?: unknown }).event_id, status: s, ...(s === "refused" ? { error: { code: "payload_malformed", message: "refused" } } : {}) };
  });
  return new Response(JSON.stringify({ results: answers }), { status: 200 });
}

/** What a spy on a print function was called with, one string per call. */
export function messages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([message]) => String(message));
}

/** A sink whose every write rejects. */
export function failingSink(): Sink {
  return { write: () => Promise.reject(new Error("sink down")), flush: async () => {}, aclose: async () => {} };
}

/** A fetch that accepts every event it is sent. */
export const acceptAll = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
  Promise.resolve(results(sentIn(init)));

export function makeEvent(overrides: Partial<{ sequence_number: number }> = {}): Event {
  return ToolCallStartEventSchema.parse({
    tenant_id: "t",
    vendor_id: "v",
    session_id: "s",
    sequence_number: overrides.sequence_number ?? 0,
    captured_at: new Date().toISOString(),
    consent_token: "ct",
    call_id: "call-1",
    payload: { tool_name: "lookup" },
  });
}
