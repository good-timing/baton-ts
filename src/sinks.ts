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
 * - `HttpSink` — POST batches to any HTTP endpoint with bearer auth;
 *   bounded buffer, retry with backoff, circuit breaker. This is the contract a
 *   Console or any compatible collector consumes.
 * - `MultiSink` — every event to each of several sinks.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { capCodePoints, escapeForLog } from "./_text.js";
import { MAX_TIMER_MS, raceDeadline, SHUTDOWN_FLUSH_TIMEOUT_MS, TIMED_OUT } from "./deadline.js";
import { PROCESS_DROPS } from "./drops.js";
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

function flushIntervalOption(given: unknown): number {
  if (isTimerMs(given)) return given;
  if (given !== undefined) {
    warn(`baton: flushIntervalMs must be from 0 to ${MAX_TIMER_MS} ms; using ${FLUSH_INTERVAL_MS}.`);
  }
  return FLUSH_INTERVAL_MS;
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
// HttpSink — batches + bearer + bounded buffer + retry + circuit breaker
// =============================================================================

/** SPEC §2.5's caps on one batch. */
const BATCH_MAX_EVENTS = 100;
const BATCH_MAX_BYTES = 1_048_576;
/** `{"events":[` and `]}`. */
const BATCH_FRAME_BYTES = 13;
const FLUSH_INTERVAL_MS = 5000;

type SendOutcome = "success" | "permanent_failure" | "transient_failure";

/** An encoded event waiting in the buffer, or the loss report riding a batch
 * (`reportSum` set), which is never in the buffer. */
interface Waiting {
  event: Event;
  json: string;
  bytes: number;
  writtenAt: number;
  reportSum?: number;
}

type Answer =
  | { kind: "answered"; refused: Set<number> }
  | { kind: "refused"; status: number }
  | { kind: "too_large" }
  | { kind: "no_batch_endpoint" }
  | { kind: "transient"; retryAfterMs: number | null };

const utf8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return typeof Buffer === "undefined" ? utf8.encode(text).length : Buffer.byteLength(text, "utf8");
}

function batchKey(event: Event): string {
  return `${event.tenant_id}\u0000${event.vendor_id}`;
}

/** Seconds or an HTTP date; `null` when absent or unreadable. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const value = header.trim();
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_TIMER_MS);
}

class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  canRequest(): boolean {
    return this.msUntilRequest() === 0;
  }

  msUntilRequest(): number {
    if (this.openedAt === null) return 0;
    return Math.max(this.openedAt + this.resetMs - Date.now(), 0);
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
  /** The longest an event waits before its batch is sent, in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** POST events to an HTTP endpoint in batches. Bounded buffer + retry +
 * circuit breaker.
 *
 * This is the contract a Console or any compatible collector consumes:
 * `POST {url}/v0/events/batch` (SPEC §2.5) with `Authorization: Bearer
 * {apiKey}` and `{"events": [...]}` of SPEC §11.4 envelopes. A batch goes when
 * 100 events wait, when the next would take the body over 1 MiB, or
 * `flushIntervalMs` after the oldest waiting one was written. A collector
 * with no batch endpoint gets one event per `POST {url}/v0/events`.
 *
 * Failures are bounded — buffer overflow drops the oldest event; network
 * failures retry with backoff; the circuit breaker opens after consecutive
 * failures so the SDK doesn't pile retries on a known-bad endpoint. */
export class HttpSink implements Sink {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly buffer: Waiting[] = [];
  private bufferedBytes = 0;
  private readonly bufferSize: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownFlushTimeoutMs: number;
  private readonly flushIntervalMs: number;
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
  /** Per status or refusal code, so a new kind of refusal, such as a 401
   * after a 422, still warns. */
  private readonly refusals = new Map<string, { loggedAt: number; unlogged: number }>();
  /** Aborted once `aclose()` returns: nothing Baton started may keep the
   * process alive after the vendor closed it. */
  private readonly closing = new AbortController();
  private closeStarted = false;
  /** The drain chain's tail when a flush() or aclose() gave up waiting, until it settles. */
  private stalledDrain: Promise<unknown> | null = null;
  private skipWarnedFor: Promise<unknown> | null = null;
  private closeOnce: Promise<void> | undefined;
  private drainChain: Promise<void> = Promise.resolve();
  private queuedDrain: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** No batch before this `Date.now()`, from a 429's `Retry-After`. */
  private retryAt = 0;
  /** Set for the life of the sink by a 404 or 405 on the batch path. */
  private batchless = false;
  private exitHooks: { beforeExit: () => void; exit: () => void } | null = null;
  /** The least time between two of this sink's loss reports. */
  private static reportIntervalMs = 60_000;
  /** Totals only grow, so their sum tells whether they changed. */
  private reportedSum = 0;
  private lastReportAt = -Infinity;
  private reportsStopped = false;
  /** The envelope of a report due to ride the next batch. */
  private pendingReport: Pick<Event, "tenant_id" | "vendor_id" | "consent_token"> | null = null;

  constructor(url: string, options: HttpSinkOptions) {
    this.url = url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.bufferSize = options.bufferSize ?? 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1000;
    this.shutdownFlushTimeoutMs = shutdownFlushTimeoutOption(options.shutdownFlushTimeoutMs);
    this.flushIntervalMs = flushIntervalOption(options.flushIntervalMs);
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
    const json = this.encode(event);
    if (json === null) return;
    this.enqueue({ event, json, bytes: utf8Bytes(json), writtenAt: Date.now() });
    this.unsentWarned = false;
    if (this.batchIsFull()) void this.scheduleDrain();
    else this.armTimer(this.buffer[0]!.writtenAt + this.flushIntervalMs - Date.now());
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
    this.closeStarted = true;
    this.stopReports();
    await this.drainWithinBudget("aclose()", ms);
    this.closing.abort();
    this.clearTimer();
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

  private enqueue(waiting: Waiting): void {
    if (this.buffer.length >= this.bufferSize) {
      PROCESS_DROPS.add("buffer_full");
      if (!this.overflowWarned) {
        warn(
          `Baton HTTP sink buffer full (${this.bufferSize}); oldest events dropped. Further overflows will be silent.`,
        );
        this.overflowWarned = true;
      }
      this.bufferedBytes -= this.buffer.shift()!.bytes;
    }
    this.buffer.push(waiting);
    this.bufferedBytes += waiting.bytes;
  }

  /** Takes the sent entries out of the buffer. A full buffer may already have
   * pushed some out while they were being sent; the rest are still its head. */
  private release(batch: readonly Waiting[]): void {
    for (const waiting of batch) {
      if (this.buffer[0] === waiting) {
        this.buffer.shift();
        this.bufferedBytes -= waiting.bytes;
      }
    }
  }

  private batchIsFull(): boolean {
    return (
      this.buffer.length >= BATCH_MAX_EVENTS ||
      BATCH_FRAME_BYTES + this.bufferedBytes + this.buffer.length - 1 > BATCH_MAX_BYTES
    );
  }

  /** The timer must not keep the vendor's process alive: the exit hooks send
   * what is left. */
  private armTimer(delayMs: number): void {
    if (this.flushTimer !== null || this.closed) return;
    const timer = setTimeout(
      () => {
        this.flushTimer = null;
        void this.scheduleDrain();
      },
      Math.min(Math.max(delayMs, 0), MAX_TIMER_MS),
    );
    (timer as { unref?: () => void }).unref?.();
    this.flushTimer = timer;
  }

  private clearTimer(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** Runs `drainLocked` after the pass under way, one pass at a time, so two
   * never send at once or race on the buffer. A pass not yet started sends
   * everything in the buffer when it starts, so callers share it: one per
   * write would grow without bound while a slow collector holds a pass. */
  private scheduleDrain(): Promise<void> {
    if (this.queuedDrain) return this.queuedDrain;
    const run = (): Promise<void> => {
      this.queuedDrain = null;
      return this.drainLocked();
    };
    this.queuedDrain = this.drainChain.then(run, run);
    this.drainChain = this.queuedDrain;
    return this.queuedDrain;
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

  /** One attempt per batch, no retry, within `shutdownFlushTimeoutMs` in
   * total (SPEC §11.2); what is left is reported, not sent. */
  private async exitPass(): Promise<void> {
    const deadline = Date.now() + this.shutdownFlushTimeoutMs;
    while (this.circuit.canRequest() && Date.now() < deadline) {
      const batch = this.cutBatch(false);
      if (batch === null) break;
      if (!(await this.sendBatch(batch, 0, deadline))) break;
    }
    this.exitPassRan = true;
    this.unsentWarned = true;
    if (this.buffer.length > 0) warn(this.unsentAtExit());
    this.warnUnloggedRefusals("process exiting");
  }

  private unsentAtExit(): string {
    return `baton: process exiting with ${this.buffer.length} unsent event(s).`;
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
  private static logRefusal(refused: number, why: string, detail: string, unlogged: number): void {
    const what = refused === 1 ? "an event and it has" : `${refused} events and they have`;
    warn(
      `baton: collector REFUSED ${what} been dropped (${why}): ` +
        `${escapeForLog(capCodePoints(detail, REFUSAL_BODY_MAX_LEN))} — the event is gone; nothing retries a refusal.` +
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

  /** How many refusals of `kind` went unlogged before these `n`, or `null`
   * when these go unlogged too. */
  private refusalToLog(kind: string, n: number): number | null {
    const now = performance.now();
    const seen = this.refusals.get(kind);
    if (seen !== undefined && now - seen.loggedAt < REFUSAL_LOG_MS) {
      seen.unlogged += n;
      return null;
    }
    this.refusals.set(kind, { loggedAt: now, unlogged: 0 });
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

  /** Sends everything waiting, in batches. A report pending when the pass
   * starts rides along; one armed by this pass's own delivery waits for the
   * next batch. */
  private async drainLocked(): Promise<void> {
    let failed = false;
    let reportDue = this.pendingReport !== null;
    while (!this.closed) {
      if (!this.circuit.canRequest() || (!this.closeStarted && Date.now() < this.retryAt)) {
        failed = true;
        break;
      }
      const batch = this.cutBatch(reportDue);
      if (batch === null) break;
      if (batch.some((w) => w.reportSum !== undefined)) reportDue = false;
      if (!(await this.sendBatch(batch, this.maxRetries, Infinity))) {
        failed = true;
        break;
      }
    }
    if (!failed && this.buffer.length === 0) this.exitPassRan = false;
    this.clearTimer();
    // A failed batch is tried again when the timer fires, not only on the next
    // write. The backoff floor keeps a zero interval from spinning.
    if (this.buffer.length > 0) {
      const waits = [this.flushIntervalMs, this.backoffBaseMs, this.retryAt - Date.now(), this.circuit.msUntilRequest()];
      this.armTimer(Math.max(...waits));
    }
    else if (this.pendingReport !== null) this.armTimer(this.flushIntervalMs);
  }

  /** The head of the buffer that fits one request: one tenant and vendor
   * (SPEC §2.5), at most 100 events and 1 MiB, but always at least one event,
   * so an event over the cap is sent alone and refused by the collector. */
  private cutBatch(withReport: boolean): Waiting[] | null {
    const maxEvents = this.batchless ? 1 : BATCH_MAX_EVENTS;
    const batch: Waiting[] = [];
    let bytes = BATCH_FRAME_BYTES - 1;
    const fits = (w: Waiting): boolean =>
      batch.length === 0 ||
      (batch.length < maxEvents &&
        batchKey(w.event) === batchKey(batch[0]!.event) &&
        bytes + 1 + w.bytes <= BATCH_MAX_BYTES);
    for (const waiting of this.buffer) {
      if (!fits(waiting)) break;
      batch.push(waiting);
      bytes += 1 + waiting.bytes;
    }
    // In one-event mode the report goes alone, once the buffer is empty.
    if (withReport && (!this.batchless || batch.length === 0)) {
      const report = this.buildReport();
      if (report !== null && (batch.length === 0 || fits(report))) batch.push(report);
    }
    return batch.length > 0 ? batch : null;
  }

  /** After a delivery, sets up a report of this process's loss totals (SPEC
   * §11.4.7) to ride the next batch. It stays outside the buffer, so it never
   * pushes an event out and is never counted as one. */
  private maybeReport({ tenant_id, vendor_id, consent_token }: Event): void {
    const now = performance.now();
    if (
      this.reportsStopped ||
      this.pendingReport !== null ||
      now - this.lastReportAt < HttpSink.reportIntervalMs
    ) {
      return;
    }
    const sum = Object.values(PROCESS_DROPS.total()).reduce((a, b) => a + b, 0);
    if (sum === this.reportedSum) return;
    this.lastReportAt = now;
    this.pendingReport = { tenant_id, vendor_id, consent_token };
  }

  private stopReports(): void {
    this.reportsStopped = true;
    this.pendingReport = null;
  }

  private buildReport(): Waiting | null {
    if (this.pendingReport === null) return null;
    const totals = PROCESS_DROPS.total();
    try {
      const report = ClientReportEventSchema.parse({
        ...this.pendingReport,
        session_id: PROCESS_DROPS.instanceId,
        sequence_number: nextClockSequence(),
        captured_at: new Date().toISOString(),
        payload: { instance_id: PROCESS_DROPS.instanceId, dropped: totals },
      });
      const json = JSON.stringify(report);
      const reportSum = Object.values(totals).reduce((a, b) => a + b, 0);
      return { event: report, json, bytes: utf8Bytes(json), writtenAt: Date.now(), reportSum };
    } catch {
      // A lost report is never counted (SPEC §11.4.7).
      this.pendingReport = null;
      return null;
    }
  }

  /** Sends one batch, splitting it on 413, until every event in it is
   * delivered or refused (`true`), or a failure leaves the rest buffered
   * (`false`). */
  private async sendBatch(batch: Waiting[], retries: number, deadline: number): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) return false;
      const batchless = this.batchless;
      const answer = await this.post(batch, batchless, Math.min(this.requestTimeoutMs, timeLeft));
      if (answer.kind === "no_batch_endpoint") {
        this.batchless = true;
        warn("baton: the collector has no batch endpoint; sending one event per request.");
        for (const waiting of batch) {
          const sent = await this.sendBatch([waiting], retries, deadline);
          if (!sent) return false;
        }
        return true;
      }
      if (answer.kind === "too_large") {
        const half = Math.ceil(batch.length / 2);
        return (
          (await this.sendBatch(batch.slice(0, half), retries, deadline)) &&
          this.sendBatch(batch.slice(half), retries, deadline)
        );
      }
      if (answer.kind === "transient") {
        if (answer.retryAfterMs !== null) {
          this.retryAt = Date.now() + answer.retryAfterMs;
          return false;
        }
        if (attempt < retries && !this.closed) {
          await this.sleepUnlessClosed(Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs));
          if (!this.closed) continue;
        }
        this.circuit.recordFailure();
        return false;
      }
      this.circuit.recordSuccess();
      this.settle(batch, answer);
      return true;
    }
  }

  private settle(batch: Waiting[], answer: Extract<Answer, { kind: "answered" | "refused" }>): void {
    this.release(batch);
    let lastDelivered: Event | null = null;
    for (const [i, waiting] of batch.entries()) {
      const refused = answer.kind === "refused" || answer.refused.has(i);
      if (waiting.reportSum === undefined) {
        // A whole-batch refusal was counted when it was answered.
        if (!refused) lastDelivered = waiting.event;
        else if (answer.kind === "answered") PROCESS_DROPS.add("refused");
        continue;
      }
      this.pendingReport = null;
      if (!refused) this.reportedSum = waiting.reportSum;
      // A collector that predates `client_report` refuses it this way.
      else if (answer.kind === "answered" || answer.status === 400 || answer.status === 422) this.reportsStopped = true;
    }
    if (lastDelivered !== null) {
      PROCESS_DROPS.logRecovery();
      this.maybeReport(lastDelivered);
    }
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
  private async post(batch: Waiting[], batchless: boolean, timeoutMs: number): Promise<Answer> {
    const request = new AbortController();
    const abort = (): void => request.abort();
    const timer = setTimeout(abort, timeoutMs);
    this.closing.signal.addEventListener("abort", abort);
    try {
      const response = await this.fetchImpl(batchless ? `${this.url}/v0/events` : `${this.url}/v0/events/batch`, {
        method: "POST",
        headers: this.authHeaders(),
        body: batchless ? batch[0]!.json : `{"events":[${batch.map((w) => w.json).join(",")}]}`,
        signal: request.signal,
      });
      const { status } = response;
      if (HttpSink.classifyStatus(status) === "success") {
        if (batchless) {
          void response.body?.cancel().catch(() => undefined);
          return { kind: "answered", refused: new Set() };
        }
        return { kind: "answered", refused: await this.refusedInResults(response, batch) };
      }
      const other = this.otherAnswer(status, response, batch.length, batchless);
      if (other !== null) {
        // An unread body holds its connection until GC.
        void response.body?.cancel().catch(() => undefined);
        return other;
      }
      await this.countRefusal(response, batch);
      return { kind: "refused", status };
    } catch {
      return { kind: "transient", retryAfterMs: null };
    } finally {
      clearTimeout(timer);
      this.closing.signal.removeEventListener("abort", abort);
    }
  }

  /** Every answer but a 2xx and a refusal of the whole batch. */
  private otherAnswer(status: number, response: Response, size: number, batchless: boolean): Answer | null {
    if (status === 413 && size > 1) return { kind: "too_large" };
    if ((status === 404 || status === 405) && !batchless) return { kind: "no_batch_endpoint" };
    if (status === 429) return { kind: "transient", retryAfterMs: retryAfterMs(response.headers.get("Retry-After")) };
    if (HttpSink.classifyStatus(status) === "transient_failure") return { kind: "transient", retryAfterMs: null };
    return null;
  }

  private async countRefusal(response: Response, batch: Waiting[]): Promise<void> {
    const events = batch.filter((w) => w.reportSum === undefined).length;
    PROCESS_DROPS.add("refused", events);
    const unlogged = events > 0 ? this.refusalToLog(`HTTP ${response.status}`, events) : null;
    if (unlogged === null) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    // The body read is under the request's timeout signal, so a stalled body
    // logs "<unreadable>" instead of holding the drain.
    const detail = await HttpSink.readHead(response).catch(() => "<unreadable>");
    HttpSink.logRefusal(events, `HTTP ${response.status}`, detail, unlogged);
  }

  /** A 2xx whose body cannot be read is taken as accepting every event: the
   * collector said it took the batch. */
  private async refusedInResults(
    response: Response,
    batch: Waiting[],
  ): Promise<Set<number>> {
    const refused = new Set<number>();
    const body: unknown = await response.json().catch(() => null);
    const results: unknown = (body as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return refused;
    batch.forEach((waiting, i) => {
      const result = results[i] as { status?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
      if (result?.status !== "refused") return;
      refused.add(i);
      if (waiting.reportSum !== undefined) return;
      const text = (value: unknown): string => (typeof value === "string" ? value : "");
      const code = text(result.error?.code) || "no code";
      const unlogged = this.refusalToLog(code, 1);
      if (unlogged !== null) HttpSink.logRefusal(1, code, text(result.error?.message), unlogged);
    });
    return refused;
  }
}
