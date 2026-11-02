/**
 * Sinks — where Baton events go after the SDK captures them.
 *
 * A `Sink` is the egress side of the SDK; `withBaton` hands fully-formed
 * `Event` envelopes to a sink and the sink decides what to do with them.
 *
 * The same four sinks as `sinks.py`:
 *
 * - `StdoutSink` — JSONL to a writable stream (default `process.stderr`,
 *   for the same reason as Python: MCP stdio transport reserves stdout for
 *   JSON-RPC framing).
 * - `FileSink` — JSONL appended to a file.
 * - `HttpSink` — POST to any HTTP endpoint with bearer auth; bounded
 *   buffer, retry with backoff, circuit breaker. This is the contract a
 *   Console or any compatible collector consumes.
 * - `MultiSink` — every event to each of several sinks.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { capCodePoints, escapeForLog } from "./_text.js";
import { MAX_TIMER_MS, raceDeadline, SHUTDOWN_FLUSH_TIMEOUT_MS, TIMED_OUT } from "./deadline.js";
import { type DropReason, PROCESS_DROPS } from "./drops.js";
import { ClientReportEventSchema, type Event } from "./events.js";
import { nextClockSequence } from "./sequence.js";
import { printable, warn } from "./warn.js";

const REFUSAL_BODY_MAX_LEN = 500;
/** The least time between two refusal warnings with the same status, so a
 * collector refusing every event is not one warning per event. */
const REFUSAL_LOG_MS = 60_000;

export interface Sink {
  /** Hand one event to the sink. Resolves once the sink has accepted it
   * (which may mean buffered, not yet shipped). MUST NOT block the
   * producer on slow downstream destinations. */
  write(event: Event): Promise<void>;
  /** Wait for any buffered events to reach their destination (or be
   * dropped per the sink's policy). No-op for synchronous sinks. */
  flush(): Promise<void>;
  /** Flush + release resources. After `aclose`, `write` rejects with
   * `SinkClosedError`. */
  aclose(): Promise<void>;
}

/** `write` was called after `aclose`. */
export class SinkClosedError extends Error {
  override name = "SinkClosedError";
}

/** By name, not `instanceof`: a vendor sink may throw the class from the
 * other build (ESM or CommonJS) of this package. */
export function isSinkClosed(err: unknown): boolean {
  return err instanceof Error && err.name === "SinkClosedError";
}

const warnedClosed = new WeakSet<Sink>();

/** SPEC §11.2 rules 7 and 8: dropped, counted under `after_close`, and
 * warned about once per sink. */
export function droppedAfterClose(sink: Sink): void {
  PROCESS_DROPS.add("after_close");
  if (warnedClosed.has(sink)) return;
  warnedClosed.add(sink);
  warn("baton: the sink is closed; further events are dropped.");
}

/** Fail-open wrapper around `sink.write`.
 *
 * The MCP tool wrapper sits BEFORE the vendor's tool handler runs. A reject
 * from `sink.write` (closed sink, transport error, etc.) would otherwise
 * propagate up and break the vendor's tool call — making Baton
 * instrumentation look like a vendor bug. SPEC §11.2 mandates fail-open at
 * the capture boundary; this wrapper enforces it. */
export async function safeWrite(sink: Sink, event: Event): Promise<void> {
  try {
    await sink.write(event);
  } catch (err) {
    if (isSinkClosed(err)) return droppedAfterClose(sink);
    PROCESS_DROPS.add("write_failed");
    process.stderr.write(`baton: sink.write failed; event dropped, tool call continues: ${printable(err)}\n`);
  }
}

function stderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function isTimerMs(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= MAX_TIMER_MS;
}

function shutdownFlushTimeoutOption(given: unknown): number {
  if (isTimerMs(given)) return given;
  if (given !== undefined) {
    warn(`baton: shutdownFlushTimeoutMs must be from 0 to ${MAX_TIMER_MS} ms; using ${SHUTDOWN_FLUSH_TIMEOUT_MS}.`);
  }
  return SHUTDOWN_FLUSH_TIMEOUT_MS;
}

function shutdownBudgetMs(sink: Sink): number {
  try {
    // MultiSink runs its sinks side by side, so it needs the longest budget.
    if (sink instanceof MultiSink) return Math.max(...sink["sinks"].map(shutdownBudgetMs));
    const budget: unknown = sink instanceof HttpSink ? sink["shutdownFlushTimeoutMs"] : undefined;
    if (isTimerMs(budget)) return budget;
  } catch {
    // A Proxy or subclass whose read throws gets the default.
  }
  return SHUTDOWN_FLUSH_TIMEOUT_MS;
}

/** A sink's `flush()` or `aclose()`, telling Baton's own how much time is
 * left. Any other, a subclass's override included, is called as it is. */
export function callWithin(sink: Sink, method: "flush" | "aclose", ms: number): Promise<void> {
  if (sink[method] === HttpSink.prototype[method]) return (sink as HttpSink)[`${method}Within`](ms);
  if (sink[method] === MultiSink.prototype[method]) return (sink as MultiSink)[`${method}Within`](ms);
  return sink[method]();
}

/** Run a sink's `flush()` or `aclose()` for the vendor (or `work`, which is
 * handed the budget and ends in one): never rejects, and returns within the
 * sink's shutdown budget. The budget gets a little extra, so `HttpSink`, which
 * enforces its own, is the one whose warning, which counts what was left, is
 * shown. */
export async function boundedSinkCall(
  sink: Sink,
  method: "flush" | "aclose",
  work: (budgetMs: number) => unknown = () => sink[method](),
): Promise<void> {
  const what = `${method}()`;
  const budget = shutdownBudgetMs(sink);
  const ms = budget + 250;
  // `Promise.resolve().then(work)` also catches a sync throw and a method
  // that returns no promise.
  const settled = Promise.resolve()
    .then(() => work(budget))
    .then(
      () => undefined,
      (err: unknown) => warn(`baton: ${what} failed: ${printable(err)}`),
    );
  if ((await raceDeadline(settled, ms)) === TIMED_OUT) {
    warn(`baton: ${what} took over ${String(ms)} ms and was left unfinished.`);
  }
}

// =============================================================================
// StdoutSink — JSONL to a writable stream (default: stderr)
// =============================================================================

export interface StdoutSinkOptions {
  /** Defaults to `process.stderr` — stdio MCP transport reserves stdout for
   * JSON-RPC framing. Pass `process.stdout` explicitly for non-MCP (library
   * API) use if preferred. */
  stream?: NodeJS.WritableStream;
}

export class StdoutSink implements Sink {
  private readonly stream: NodeJS.WritableStream;
  private closed = false;

  constructor(options: StdoutSinkOptions = {}) {
    this.stream = options.stream ?? process.stderr;
  }

  async write(event: Event): Promise<void> {
    if (this.closed) throw new SinkClosedError("StdoutSink is closed");
    this.stream.write(JSON.stringify(event) + "\n");
  }

  async flush(): Promise<void> {
    // Node writable streams don't expose a synchronous flush; write() above
    // already pushes each line through immediately.
  }

  async aclose(): Promise<void> {
    this.closed = true;
    // Don't end the stream — we don't own stderr/stdout.
  }
}

// =============================================================================
// FileSink — JSONL append to a path
// =============================================================================

/** Appends one JSON envelope per line to a file, opened on the first write so
 * an unused sink creates no file. Each line reaches the file before `write`
 * resolves, so `tail -f` sees it at once. */
export class FileSink implements Sink {
  private fd: number | null = null;
  private closed = false;

  constructor(private readonly path: string) {}

  async write(event: Event): Promise<void> {
    if (this.closed) throw new SinkClosedError("FileSink is closed");
    // Synchronous so concurrent writes land in call order: async writes on
    // one fd go through the libuv thread pool and can interleave.
    this.fd ??= openSync(this.path, "a");
    writeSync(this.fd, JSON.stringify(event) + "\n");
  }

  async flush(): Promise<void> {}

  async aclose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

// =============================================================================
// MultiSink — fan out to several sinks
// =============================================================================

/** Sends each event to every sink, e.g. `new MultiSink([new StdoutSink(),
 * new HttpSink(...)])` to watch what is shipped. Every sink is tried even when
 * one fails; one failure is rethrown as is, several as an `AggregateError`. */
export class MultiSink implements Sink {
  private readonly sinks: readonly Sink[];

  constructor(sinks: readonly Sink[]) {
    if (sinks.length === 0) throw new Error("MultiSink requires at least one sink");
    this.sinks = [...sinks];
  }

  write(event: Event): Promise<void> {
    return this.fanOut((sink) => sink.write(event));
  }

  flush(): Promise<void> {
    return this.flushWithin(Infinity);
  }

  aclose(): Promise<void> {
    return this.acloseWithin(Infinity);
  }

  private flushWithin(ms: number): Promise<void> {
    return this.fanOut((sink) => callWithin(sink, "flush", ms));
  }

  private acloseWithin(ms: number): Promise<void> {
    return this.fanOut((sink) => callWithin(sink, "aclose", ms));
  }

  private async fanOut(op: (sink: Sink) => Promise<void>): Promise<void> {
    // The async wrapper turns a sink that throws synchronously into a rejection.
    const results = await Promise.allSettled(this.sinks.map(async (sink) => op(sink)));
    let errors = results.flatMap((r): unknown[] => (r.status === "rejected" ? [r.reason] : []));
    // Another sink took the event, so it was not lost.
    if (errors.length < results.length) errors = errors.filter((e) => !isSinkClosed(e));
    if (errors.length === 0) return;
    if (errors.length === 1 || errors.every(isSinkClosed)) throw errors[0];
    throw new AggregateError(errors, "MultiSink fan-out failures");
  }
}

// =============================================================================
// HttpSink — POST + bearer + bounded buffer + retry + circuit breaker
// =============================================================================

type SendOutcome = "success" | "permanent_failure" | "transient_failure" | "unencodable";

class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  canRequest(): boolean {
    if (this.openedAt === null) return true;
    return Date.now() - this.openedAt >= this.resetMs;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
    }
  }
}

export interface HttpSinkOptions {
  apiKey: string;
  bufferSize?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
  /** How long the flush at process exit, or an explicit `flush()` or
   * `aclose()`, may take in total, in ms, at most 2^31 - 1. Default 3000. */
  shutdownFlushTimeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** POST events to an HTTP endpoint. Bounded buffer + retry + circuit breaker.
 *
 * This is the contract a Console or any compatible collector consumes:
 * `POST {url}/v0/events` with `Authorization: Bearer {apiKey}` and a JSON
 * body matching the SPEC §11.4 envelope.
 *
 * Failures are bounded — buffer overflow drops the oldest event; network
 * failures retry with backoff; the circuit breaker opens after consecutive
 * failures so the SDK doesn't pile retries on a known-bad endpoint. */
export class HttpSink implements Sink {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly buffer: Event[] = [];
  private readonly bufferSize: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownFlushTimeoutMs: number;
  /** Set when an exit pass ends; cleared once a normal drain empties the
   * buffer, which means the process went on. */
  private exitPassRan = false;
  /** Whether the exit pass warned about every event now buffered. */
  private unsentWarned = false;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly circuit: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private overflowWarned = false;
  /** Per status, so a new kind of refusal, such as a 401 after a 422, still warns. */
  private readonly refusals = new Map<number, { loggedAt: number; unlogged: number }>();
  /** Aborted once `aclose()` returns: nothing Baton started may keep the
   * process alive after the vendor closed it. */
  private readonly closing = new AbortController();
  /** The drain chain's tail when a flush() or aclose() gave up waiting, until it settles. */
  private stalledDrain: Promise<unknown> | null = null;
  private skipWarnedFor: Promise<unknown> | null = null;
  private closeOnce: Promise<void> | undefined;
  private drainChain: Promise<void> = Promise.resolve();
  private exitHooks: { beforeExit: () => void; exit: () => void } | null = null;
  /** The least time between two of this sink's loss reports. */
  private static reportIntervalMs = 60_000;
  /** Totals only grow, so their sum tells whether they changed. */
  private reportedSum = 0;
  private lastReportAt = -Infinity;
  private reportsStopped = false;
  private reportInFlight: AbortController | null = null;

  constructor(url: string, options: HttpSinkOptions) {
    this.url = url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.bufferSize = options.bufferSize ?? 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1000;
    this.shutdownFlushTimeoutMs = shutdownFlushTimeoutOption(options.shutdownFlushTimeoutMs);
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 100;
    this.backoffMaxMs = options.backoffMaxMs ?? 5000;
    this.circuit = new CircuitBreaker(
      options.circuitBreakerThreshold ?? 5,
      options.circuitBreakerResetMs ?? 30_000,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * What this sink shows when something prints it — never the bearer.
   *
   * ⚠ **A sink built from a DSN holds a key the vendor never typed**, and it
   * hangs off `BatonHandle.sink` and off the resolved config, so
   * `console.log(handle.sink)` or a structured logger serialising either one
   * would write a publishable key into the vendor's logs. Same treatment as the parsed DSN —
   * `toJSON` for serialisers, the inspect symbol for `console.log`, and
   * `Symbol.for` rather than importing `node:util`, since this package runs on
   * runtimes that have no such module.
   */
  toJSON(): Record<string, unknown> {
    return { url: this.url, apiKey: "<key>" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }

  private get closed(): boolean {
    return this.closing.signal.aborted;
  }

  async write(event: Event): Promise<void> {
    if (this.closed) throw new SinkClosedError("HttpSink is closed");
    this.enqueue(event);
    this.unsentWarned = false;
    void this.scheduleDrain();
    this.ensureExitHooksRegistered();
  }

  flush(): Promise<void> {
    return this.flushWithin(Infinity);
  }

  /** A second call waits for the first (SPEC §11.2 rule 7). */
  aclose(): Promise<void> {
    return this.acloseWithin(Infinity);
  }

  private async flushWithin(ms: number): Promise<void> {
    if (this.closed) return;
    await this.drainWithinBudget("flush()", Math.min(ms, this.shutdownFlushTimeoutMs));
  }

  private acloseWithin(ms: number): Promise<void> {
    this.closeOnce ??= this.close(Math.min(ms, this.shutdownFlushTimeoutMs));
    return this.closeOnce;
  }

  private async close(ms: number): Promise<void> {
    this.stopReports();
    await this.drainWithinBudget("aclose()", ms);
    this.closing.abort();
    if (this.buffer.length > 0) {
      PROCESS_DROPS.add("unsent_at_close", this.buffer.length);
      warn(`baton: the sink closed with ${this.buffer.length} event(s) unsent.`);
    }
    this.warnUnloggedRefusals("the sink closed");
    if (this.exitHooks) {
      process.off("beforeExit", this.exitHooks.beforeExit);
      process.off("exit", this.exitHooks.exit);
      this.exitHooks = null;
    }
  }

  /** SPEC §11.2 rule 7: an explicit flush or close returns within `ms` and
   * never rejects. While an earlier wait's drain is still stuck, a flush
   * returns at once, without queuing a pass, and a close gives it `ms`. The
   * drain is not cancelled here, so after `flush()` it goes on sending;
   * `aclose()` stops it. */
  private async drainWithinBudget(what: "flush()" | "aclose()", ms: number): Promise<void> {
    if (this.stalledDrain) {
      if (what === "aclose()") {
        await raceDeadline(this.stalledDrain, ms);
        return;
      }
      if (this.skipWarnedFor !== this.stalledDrain) {
        this.skipWarnedFor = this.stalledDrain;
        warn(`baton: flush() skipped: an earlier drain is still stuck; ${this.buffer.length} event(s) wait to be sent.`);
      }
      return;
    }
    const settled = this.scheduleDrain().catch(() => undefined);
    if ((await raceDeadline(settled, ms)) !== TIMED_OUT) return;
    // A wait shorter than the budget, the time a caller had left, does not
    // show that the drain is stuck.
    if (ms < this.shutdownFlushTimeoutMs) return;
    const stalled = this.drainChain.catch(() => undefined);
    this.stalledDrain = stalled;
    void stalled.then(() => {
      if (this.stalledDrain === stalled) this.stalledDrain = null;
    });
    if (what === "flush()") {
      warn(`baton: flush() took over ${ms} ms; it goes on in the background.`);
    }
  }

  /** A full buffer may already have pushed `event` out while it was being sent. */
  private dequeue(event: Event): void {
    if (this.buffer[0] === event) this.buffer.shift();
  }

  private enqueue(event: Event): void {
    if (this.buffer.length >= this.bufferSize) {
      PROCESS_DROPS.add("buffer_full");
      if (!this.overflowWarned) {
        warn(
          `Baton HTTP sink buffer full (${this.bufferSize}); oldest events dropped. Further overflows will be silent.`,
        );
        this.overflowWarned = true;
      }
      this.buffer.shift();
    }
    this.buffer.push(event);
  }

  /** Serializes every call to `drainLocked` — from `write()`'s background
   * drain and from explicit `flush()` alike — onto one promise chain, so
   * concurrent tool calls (the normal case once the MCP interceptor is
   * wired up) can never run two drains at once racing on `buffer[0]`/
   * `shift()`. Mirrors Python's `asyncio.Lock` around `_drain_locked`. */
  private scheduleDrain(): Promise<void> {
    this.drainChain = this.drainChain.then(
      () => this.drainLocked(),
      () => this.drainLocked(),
    );
    return this.drainChain;
  }

  /** Best-effort flush when the process is about to exit without an
   * explicit `aclose()`. SIGKILL, or SIGTERM with no installed handler, skip
   * both hooks: a vendor needing that guarantee must call `aclose()` from
   * their own handler. */
  private ensureExitHooksRegistered(): void {
    if (this.exitHooks) return;
    const beforeExit = (): void => {
      // Node re-fires `beforeExit` once the pass's work is done; one pass only.
      if (this.buffer.length === 0 || this.exitPassRan) {
        this.warnUnloggedRefusals("process exiting");
        return;
      }
      this.drainChain = this.drainChain.then(
        () => this.exitPass(),
        () => this.exitPass(),
      );
    };
    // `process.exit()` skips `beforeExit`. At `exit` nothing can be sent and
    // `emitWarning` would never print, so the count is written straight out.
    const exit = (): void => {
      try {
        if (this.buffer.length > 0 && !this.unsentWarned) stderrLine(this.unsentAtExit());
        this.warnUnloggedRefusals("process exiting", stderrLine);
      } catch {
        // A throw here would turn the vendor's clean exit into a crash.
      }
    };
    this.exitHooks = { beforeExit, exit };
    process.on("beforeExit", beforeExit);
    process.on("exit", exit);
  }

  /** One attempt per event, no retry, within `shutdownFlushTimeoutMs` in
   * total (SPEC §11.2); what is left is reported, not sent. */
  private async exitPass(): Promise<void> {
    const deadline = Date.now() + this.shutdownFlushTimeoutMs;
    while (this.buffer.length > 0 && this.circuit.canRequest()) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) break;
      const event = this.buffer[0]!;
      const body = this.encode(event);
      if (body !== null) {
        const outcome = await this.postOnce(body, Math.min(this.requestTimeoutMs, timeLeft));
        if (outcome === "transient_failure") {
          this.circuit.recordFailure();
          break;
        }
        this.circuit.recordSuccess();
      }
      this.dequeue(event);
    }
    this.exitPassRan = true;
    this.unsentWarned = true;
    if (this.buffer.length > 0) warn(this.unsentAtExit());
    this.warnUnloggedRefusals("process exiting");
  }

  private unsentAtExit(): string {
    return `baton: process exiting with ${this.buffer.length} unsent event(s).`;
  }

  private events_url(): string {
    return `${this.url}/v0/events`;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private static classifyStatus(status: number): SendOutcome {
    if (status >= 200 && status < 300) return "success";
    if (status >= 400 && status < 500 && status !== 429) return "permanent_failure";
    return "transient_failure";
  }

  /** A refused event is otherwise dropped silently, which looks the same from
   * the vendor's process as an accepted one. The collector's own message is
   * logged because it names the field at fault; it is capped and escaped
   * because it is a remote server's text landing in the vendor's log. */
  private static async logRefusal(response: Response, unlogged: number): Promise<void> {
    // The body read is under the request's timeout signal, so a stalled body
    // logs "<unreadable>" instead of holding the drain.
    const detail = await HttpSink.readHead(response).then(
      (text) => escapeForLog(capCodePoints(text, REFUSAL_BODY_MAX_LEN)),
      () => "<unreadable>",
    );
    warn(
      `baton: collector REFUSED an event and it has been dropped ` +
        `(HTTP ${response.status}): ${detail} — the event is gone; nothing retries a 4xx.` +
        (unlogged > 0 ? ` ${unlogged} more refused since the last such warning.` : ""),
    );
  }

  private warnUnloggedRefusals(when: string, emit: (message: string) => void = warn): void {
    let total = 0;
    for (const seen of this.refusals.values()) {
      total += seen.unlogged;
      seen.unlogged = 0;
    }
    if (total > 0) emit(`baton: ${when}; ${total} more event(s) refused since the last such warning.`);
  }

  /** How many refusals with `status` went unlogged before this one, or `null`
   * when this one goes unlogged too. */
  private refusalToLog(status: number): number | null {
    const now = performance.now();
    const seen = this.refusals.get(status);
    if (seen !== undefined && now - seen.loggedAt < REFUSAL_LOG_MS) {
      seen.unlogged++;
      return null;
    }
    this.refusals.set(status, { loggedAt: now, unlogged: 0 });
    return seen?.unlogged ?? 0;
  }

  /** Enough of the body for `REFUSAL_BODY_MAX_LEN` code points; the rest is
   * cancelled unread, so a large error page does not hold the drain. */
  private static async readHead(response: Response): Promise<string> {
    const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader === undefined) return "";
    const decoder = new TextDecoder();
    let text = "";
    try {
      // A code point is at most two UTF-16 units.
      while (text.length < REFUSAL_BODY_MAX_LEN * 2) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
      return text;
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  private async drainLocked(): Promise<void> {
    while (this.buffer.length > 0) {
      if (!this.circuit.canRequest() || this.closing.signal.aborted) return;
      const event = this.buffer[0]!;
      const outcome = await this.sendWithRetry(event);
      if (outcome === "success" || outcome === "permanent_failure") {
        this.dequeue(event);
        this.circuit.recordSuccess();
        if (outcome === "success") {
          PROCESS_DROPS.logRecovery();
          this.maybeReport(event);
        }
      } else if (outcome === "unencodable") {
        // Nothing was sent, so the circuit learns nothing about the endpoint.
        this.dequeue(event);
      } else {
        this.circuit.recordFailure();
        return;
      }
    }
    this.exitPassRan = false;
  }

  /** Starts a report of this process's loss totals (SPEC §11.4.7) beside the
   * drain and outside the buffer, so it never delays an event and is never
   * counted as one. */
  private maybeReport({ tenant_id, vendor_id, consent_token }: Event): void {
    const now = performance.now();
    if (
      this.reportsStopped ||
      this.reportInFlight !== null ||
      now - this.lastReportAt < HttpSink.reportIntervalMs
    ) {
      return;
    }
    const totals = PROCESS_DROPS.total();
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    if (sum === this.reportedSum) return;
    this.lastReportAt = now;
    const abort = new AbortController();
    this.reportInFlight = abort;
    const envelope = { tenant_id, vendor_id, consent_token };
    void this.sendReport(envelope, totals, sum, abort).finally(() => {
      this.reportInFlight = null;
    });
  }

  private stopReports(): void {
    this.reportsStopped = true;
    this.reportInFlight?.abort();
  }

  private async sendReport(
    envelope: Pick<Event, "tenant_id" | "vendor_id" | "consent_token">,
    totals: Partial<Record<DropReason, number>>,
    sum: number,
    abort: AbortController,
  ): Promise<void> {
    const timer = setTimeout(() => abort.abort(), this.requestTimeoutMs);
    try {
      const report = ClientReportEventSchema.parse({
        ...envelope,
        session_id: PROCESS_DROPS.instanceId,
        sequence_number: nextClockSequence(),
        captured_at: new Date().toISOString(),
        payload: { instance_id: PROCESS_DROPS.instanceId, dropped: totals },
      });
      const response = await this.fetchImpl(this.events_url(), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(report),
        signal: abort.signal,
      });
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 400 || response.status === 422) this.reportsStopped = true;
      else if (HttpSink.classifyStatus(response.status) === "success") this.reportedSum = sum;
    } catch {
      // A lost report is never counted (SPEC §11.4.7); the next delivery may resend it.
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendWithRetry(event: Event): Promise<SendOutcome> {
    const body = this.encode(event);
    if (body === null) return "unencodable";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const outcome = await this.postOnce(body, this.requestTimeoutMs);
      if (outcome !== "transient_failure") return outcome;
      if (attempt < this.maxRetries) {
        const backoff = Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs);
        await this.sleepUnlessClosed(backoff);
        if (this.closing.signal.aborted) return "transient_failure";
      }
    }
    return "transient_failure";
  }

  /** `null`, with a warning, for an event `JSON.stringify` rejects. */
  private encode(event: Event): string | null {
    try {
      return JSON.stringify(event);
    } catch (err) {
      PROCESS_DROPS.add("encode_failed");
      // Only the error's name: its message can quote the event's own text.
      warn(
        `baton: a ${event.event_type} event could not be encoded and has been dropped (${(err as Error)?.name ?? "Error"}) — the event is gone; the events after it are still sent.`,
      );
      return null;
    }
  }

  private sleepUnlessClosed(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.closing.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.closing.signal.addEventListener("abort", done);
    });
  }

  /** Aborted by the timeout or by `aclose()`. Built by hand: `AbortSignal.any`
   * is missing before Node 20.3, and on some later versions it keeps every
   * combined signal alive as long as the long-lived `closing` signal. */
  private async postOnce(body: string, timeoutMs: number): Promise<SendOutcome> {
    const request = new AbortController();
    const abort = (): void => request.abort();
    const timer = setTimeout(abort, timeoutMs);
    this.closing.signal.addEventListener("abort", abort);
    try {
      const response = await this.fetchImpl(this.events_url(), {
        method: "POST",
        headers: this.authHeaders(),
        body,
        signal: request.signal,
      });
      const outcome = HttpSink.classifyStatus(response.status);
      if (outcome === "permanent_failure") {
        PROCESS_DROPS.add("refused");
        const unlogged = this.refusalToLog(response.status);
        if (unlogged !== null) {
          await HttpSink.logRefusal(response, unlogged);
          return outcome;
        }
      }
      // An unread body holds its connection until GC.
      void response.body?.cancel().catch(() => undefined);
      return outcome;
    } catch {
      return "transient_failure";
    } finally {
      clearTimeout(timer);
      this.closing.signal.removeEventListener("abort", abort);
    }
  }
}
