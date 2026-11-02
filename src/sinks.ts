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

function timerMsOption(given: unknown, name: string, fallback: number): number {
  if (isTimerMs(given)) return given;
  if (given !== undefined) warn(`baton: ${name} must be from 0 to ${MAX_TIMER_MS} ms; using ${fallback}.`);
  return fallback;
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

const BATCH_OPEN = '{"events":[';
const BATCH_CLOSE = "]}";
/** SPEC §2.5's caps on one batch. */
const BATCH_MAX_EVENTS = 100;
const BATCH_MAX_BYTES = 1_048_576;
const FLUSH_INTERVAL_MS = 5000;
/** SPEC §2.5: `Retry-After` is honoured from 1 to 60 seconds. */
const RETRY_AFTER_MIN_S = 1;
const RETRY_AFTER_MAX_S = 60;

type SendOutcome = "success" | "permanent_failure" | "transient_failure";

/** An event waiting to be sent, or the loss report riding a batch
 * (`reportSum` set), which is never in the buffer. */
interface Waiting {
  event: Event;
  json: string;
  bytes: number;
  writtenAt: number;
  reportSum?: number;
}

interface Refusal {
  kind: string;
  detail: string;
}

type Answer =
  | { kind: "answered"; refused: Map<string, Refusal> }
  | { kind: "refused"; refusal: Refusal; status: number }
  | { kind: "too_large" }
  | { kind: "no_batch_endpoint" }
  | { kind: "transient"; retryAfterMs: number | null };

const utf8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return typeof Buffer === "undefined" ? utf8.encode(text).length : Buffer.byteLength(text, "utf8");
}

const BATCH_FRAME_BYTES = utf8Bytes(BATCH_OPEN + BATCH_CLOSE);

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** A whole number of seconds, clamped; `null` for anything else (SPEC §2.5). */
function retryAfterMs(header: string | null): number | null {
  const value = header?.trim() ?? "";
  if (!/^\d+$/.test(value)) return null;
  return Math.min(Math.max(Number(value), RETRY_AFTER_MIN_S), RETRY_AFTER_MAX_S) * 1000;
}

function sameBatch(a: Event, b: Event): boolean {
  return a.tenant_id === b.tenant_id && a.vendor_id === b.vendor_id;
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
  /** Waiting events only: a batch being sent is out of it, so the bound
   * never pushes out an event in flight (SPEC §11.2 rule 4). */
  private readonly buffer: Waiting[] = [];
  private bufferedBytes = 0;
  private sendingEvents = 0;
  private readonly bufferSize: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownFlushTimeoutMs: number;
  private readonly flushIntervalMs: number;
  /** Set when an exit pass ends; cleared once a normal drain sends
   * everything, which means the process went on. */
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
  /** The drain chain's tail when a flush() or aclose() gave up waiting, until it settles. */
  private stalledDrain: Promise<unknown> | null = null;
  private skipWarnedFor: Promise<unknown> | null = null;
  private closeOnce: Promise<void> | undefined;
  private drainChain: Promise<void> = Promise.resolve();
  private queuedDrain: Promise<void> | null = null;
  /** Whether the queued pass sends everything waiting, not only what is due. */
  private forceNext = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by a failed batch: only the timer, a flush or a close tries again. */
  private waitForTimer = false;
  /** Nothing is sent before this `Date.now()`, from a 429's `Retry-After`. */
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
  /** The envelope of a report due to ride the next batch, and when it was set up. */
  private pendingReport: Pick<Event, "tenant_id" | "vendor_id" | "consent_token"> | null = null;
  private reportSetAt = 0;

  constructor(url: string, options: HttpSinkOptions) {
    this.url = url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.bufferSize = options.bufferSize ?? 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1000;
    this.shutdownFlushTimeoutMs = timerMsOption(
      options.shutdownFlushTimeoutMs,
      "shutdownFlushTimeoutMs",
      SHUTDOWN_FLUSH_TIMEOUT_MS,
    );
    this.flushIntervalMs = timerMsOption(options.flushIntervalMs, "flushIntervalMs", FLUSH_INTERVAL_MS);
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

  private get unsent(): number {
    return this.buffer.length + this.sendingEvents;
  }

  /** Encodes at once, not when the batch is cut, because the byte cap
   * decides when a batch goes. */
  async write(event: Event): Promise<void> {
    if (this.closed) throw new SinkClosedError("HttpSink is closed");
    const json = this.encode(event);
    if (json === null) return;
    const bytes = utf8Bytes(json);
    if (BATCH_FRAME_BYTES + bytes > BATCH_MAX_BYTES) {
      this.refuse(1, { kind: "over 1 MiB", detail: `${bytes} bytes` }, false);
      return;
    }
    this.enqueue({ event, json, bytes, writtenAt: Date.now() });
    this.unsentWarned = false;
    if (this.batchIsFull() && !this.waitForTimer) this.drainInBackground();
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
    this.stopReports();
    await this.drainWithinBudget("aclose()", ms);
    this.closing.abort();
    this.clearTimer();
    const unsent = this.unsent;
    if (unsent > 0) {
      PROCESS_DROPS.add("unsent_at_close", unsent);
      warn(`baton: the sink closed with ${unsent} event(s) unsent.`);
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
        warn(`baton: flush() skipped: an earlier drain is still stuck; ${this.unsent} event(s) wait to be sent.`);
      }
      return;
    }
    const settled = this.scheduleDrain(true).catch(() => undefined);
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
    this.buffer.push(waiting);
    this.bufferedBytes += waiting.bytes;
    this.dropOverflow();
  }

  private dropOverflow(): void {
    while (this.buffer.length > this.bufferSize) {
      PROCESS_DROPS.add("buffer_full");
      if (!this.overflowWarned) {
        warn(
          `Baton HTTP sink buffer full (${this.bufferSize}); oldest events dropped. Further overflows will be silent.`,
        );
        this.overflowWarned = true;
      }
      this.bufferedBytes -= this.buffer.shift()!.bytes;
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
        this.waitForTimer = false;
        this.drainInBackground();
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

  /** A rejection here would reach the vendor's process as an unhandled one. */
  private drainInBackground(): void {
    this.scheduleDrain(false).catch(() => undefined);
  }

  /** Runs `drainLocked` after the pass under way, one pass at a time, so two
   * never send at once or race on the buffer. A pass not yet started is
   * shared by every caller: one per write would grow without bound while a
   * slow collector holds a pass. */
  private scheduleDrain(force: boolean): Promise<void> {
    this.forceNext ||= force;
    if (this.queuedDrain) return this.queuedDrain;
    const run = (): Promise<void> => {
      this.queuedDrain = null;
      const forced = this.forceNext;
      this.forceNext = false;
      return this.drainLocked(forced);
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
      if (this.unsent === 0 || this.exitPassRan) {
        this.warnUnloggedRefusals("process exiting");
        return;
      }
      this.drainChain = this.drainChain
        .then(
          () => this.exitPass(),
          () => this.exitPass(),
        )
        .catch(() => undefined);
    };
    // `process.exit()` skips `beforeExit`. At `exit` nothing can be sent and
    // `emitWarning` would never print, so the count is written straight out.
    const exit = (): void => {
      try {
        if (this.unsent > 0 && !this.unsentWarned) stderrLine(this.unsentAtExit());
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
    while (this.circuit.canRequest() && Date.now() >= this.retryAt && Date.now() < deadline) {
      const batch = this.takeBatch(true, false);
      if (batch === null) break;
      if (!this.putBack(await this.sendBatch(batch, 0, deadline))) break;
    }
    this.exitPassRan = true;
    this.unsentWarned = true;
    if (this.unsent > 0) warn(this.unsentAtExit());
    this.warnUnloggedRefusals("process exiting");
  }

  private unsentAtExit(): string {
    return `baton: process exiting with ${this.unsent} unsent event(s).`;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private static classifyStatus(status: number): SendOutcome {
    if (status >= 200 && status < 300) return "success";
    if (status >= 400 && status < 500 && status !== 429) return "permanent_failure";
    return "transient_failure";
  }

  /** Counts `n` refused events and logs them, at most once a minute per
   * kind. A refused event is otherwise dropped silently, which looks the same
   * from the vendor's process as an accepted one. The collector's own message
   * is logged because it names the field at fault; it is capped and escaped
   * because it is a remote server's text landing in the vendor's log. */
  private refuse(n: number, { kind, detail }: Refusal, byCollector = true): void {
    if (n === 0) return;
    PROCESS_DROPS.add("refused", n);
    const unlogged = this.refusalToLog(kind, n);
    if (unlogged === null) return;
    const what = n === 1 ? "an event and it has" : `${n} events and they have`;
    warn(
      `baton: ${byCollector ? "collector REFUSED" : "REFUSED, unsent,"} ${what} been dropped (${kind}): ` +
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

  /** Sends what is due, one batch at a time; `force` (a flush or close) sends
   * everything waiting. A report set up before the pass rides along; one set
   * up by this pass's own delivery waits for the next batch. */
  private async drainLocked(force: boolean): Promise<void> {
    let failed = false;
    let reportDue = this.pendingReport !== null;
    while (!this.closed) {
      if (!this.isDue(force, reportDue)) break;
      // SPEC §2.5: nothing is sent during a 429's wait, not even at close.
      if (!this.circuit.canRequest() || Date.now() < this.retryAt) {
        failed = true;
        break;
      }
      const batch = this.takeBatch(force, reportDue);
      if (batch === null) break;
      if (batch.some((w) => w.reportSum !== undefined)) reportDue = false;
      if (!this.putBack(await this.sendBatch(batch, this.maxRetries, Infinity))) {
        failed = true;
        break;
      }
    }
    if (!failed && this.unsent === 0) this.exitPassRan = false;
    this.waitForTimer = failed;
    this.clearTimer();
    if (failed) {
      const waits = [this.flushIntervalMs, this.backoffBaseMs, this.retryAt - Date.now(), this.circuit.msUntilRequest()];
      if (this.buffer.length > 0 || this.pendingReport !== null) this.armTimer(Math.max(...waits));
      return;
    }
    const dueAt = [this.buffer[0]?.writtenAt, this.pendingReport === null ? undefined : this.reportSetAt];
    const next = Math.min(...dueAt.filter((at) => at !== undefined));
    if (next !== Infinity) this.armTimer(next + this.flushIntervalMs - Date.now());
  }

  private isDue(force: boolean, reportDue: boolean): boolean {
    const now = Date.now();
    if (this.buffer.length > 0) {
      return force || this.batchIsFull() || this.buffer[0]!.writtenAt + this.flushIntervalMs <= now;
    }
    return reportDue && this.pendingReport !== null && (force || this.reportSetAt + this.flushIntervalMs <= now);
  }

  /** Takes out of the buffer the head that fits one request: one tenant and
   * vendor (SPEC §2.5), at most 100 events and 1 MiB. */
  private takeBatch(force: boolean, withReport: boolean): Waiting[] | null {
    if (!this.isDue(force, withReport)) return null;
    const batch: Waiting[] = [];
    let bytes = BATCH_FRAME_BYTES - 1;
    const fits = (w: Waiting): boolean =>
      batch.length === 0 ||
      (batch.length < BATCH_MAX_EVENTS && sameBatch(w.event, batch[0]!.event) && bytes + 1 + w.bytes <= BATCH_MAX_BYTES);
    for (const waiting of this.buffer) {
      if (!fits(waiting)) break;
      batch.push(waiting);
      bytes += 1 + waiting.bytes;
    }
    this.buffer.splice(0, batch.length);
    this.bufferedBytes -= sum(batch.map((w) => w.bytes));
    this.sendingEvents = batch.length;
    if (withReport) {
      const report = this.buildReport();
      if (report !== null && fits(report)) batch.push(report);
    }
    return batch.length > 0 ? batch : null;
  }

  /** Puts a kept batch's events back at the head of the buffer; `true` when
   * there were none. */
  private putBack(kept: Waiting[]): boolean {
    this.sendingEvents = 0;
    const events = kept.filter((w) => w.reportSum === undefined);
    this.buffer.unshift(...events);
    this.bufferedBytes += sum(events.map((w) => w.bytes));
    this.dropOverflow();
    return kept.length === 0;
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
    if (sum(Object.values(PROCESS_DROPS.total())) === this.reportedSum) return;
    this.lastReportAt = now;
    this.reportSetAt = Date.now();
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
      return { event: report, json, bytes: utf8Bytes(json), writtenAt: Date.now(), reportSum: sum(Object.values(totals)) };
    } catch {
      // A lost report is never counted (SPEC §11.4.7).
      this.pendingReport = null;
      return null;
    }
  }

  /** Sends one batch, splitting it on 413, until every event in it is
   * delivered or refused. Returns what a failure kept, to go back in the
   * buffer. */
  private async sendBatch(batch: Waiting[], retries: number, deadline: number): Promise<Waiting[]> {
    if (this.batchless && batch.length > 1) return this.sendEachAlone(batch, retries, deadline);
    const batchless = this.batchless;
    const body = batchless ? batch[0]!.json : BATCH_OPEN + batch.map((w) => w.json).join(",") + BATCH_CLOSE;
    for (let attempt = 0; ; attempt++) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) return batch;
      const answer = await this.post(body, batch, batchless, Math.min(this.requestTimeoutMs, timeLeft));
      if (answer.kind === "no_batch_endpoint") {
        this.batchless = true;
        warn("baton: the collector has no batch endpoint; sending one event per request.");
        return this.sendEachAlone(batch, retries, deadline);
      }
      if (answer.kind === "too_large") {
        const half = Math.floor(batch.length / 2);
        const kept = await this.sendBatch(batch.slice(0, half), retries, deadline);
        if (kept.length > 0) return [...kept, ...batch.slice(half)];
        return this.sendBatch(batch.slice(half), retries, deadline);
      }
      if (answer.kind === "transient") {
        if (answer.retryAfterMs !== null) {
          this.retryAt = Date.now() + answer.retryAfterMs;
          return batch;
        }
        if (attempt < retries && !this.closed) {
          await this.sleepUnlessClosed(Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs));
          if (!this.closed) continue;
        }
        this.circuit.recordFailure();
        return batch;
      }
      this.circuit.recordSuccess();
      this.settle(batch, answer);
      return [];
    }
  }

  private async sendEachAlone(batch: Waiting[], retries: number, deadline: number): Promise<Waiting[]> {
    for (const [i, waiting] of batch.entries()) {
      const kept = await this.sendBatch([waiting], retries, deadline);
      if (kept.length > 0) return [...kept, ...batch.slice(i + 1)];
    }
    return [];
  }

  private settle(batch: Waiting[], answer: Extract<Answer, { kind: "answered" | "refused" }>): void {
    this.sendingEvents -= batch.filter((w) => w.reportSum === undefined).length;
    let lastDelivered: Event | null = null;
    const refused = new Map<string, { first: Refusal; n: number }>();
    for (const waiting of batch) {
      const refusal = answer.kind === "refused" ? answer.refusal : answer.refused.get(waiting.event.event_id);
      if (waiting.reportSum !== undefined) {
        this.pendingReport = null;
        if (refusal === undefined) this.reportedSum = waiting.reportSum;
        // A collector that predates `client_report` refuses it this way.
        else if (answer.kind === "answered" || answer.status === 400 || answer.status === 422) this.reportsStopped = true;
      } else if (refusal === undefined) {
        lastDelivered = waiting.event;
      } else {
        const seen = refused.get(refusal.kind);
        if (seen) seen.n += 1;
        else refused.set(refusal.kind, { first: refusal, n: 1 });
      }
    }
    for (const { first, n } of refused.values()) this.refuse(n, first);
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
   * combined signal alive as long as the long-lived `closing` signal. Any body
   * read is under the same signal, so a stalled body cannot hold the drain. */
  private async post(body: string, batch: Waiting[], batchless: boolean, timeoutMs: number): Promise<Answer> {
    const request = new AbortController();
    const abort = (): void => request.abort();
    const timer = setTimeout(abort, timeoutMs);
    this.closing.signal.addEventListener("abort", abort);
    try {
      const response = await this.fetchImpl(batchless ? `${this.url}/v0/events` : `${this.url}/v0/events/batch`, {
        method: "POST",
        headers: this.authHeaders(),
        body,
        signal: request.signal,
        // A followed redirect turns the POST into a GET (SPEC §2.5).
        redirect: "manual",
      });
      const { status } = response;
      const outcome = HttpSink.classifyStatus(status);
      if (outcome === "success") {
        if (batchless) {
          void response.body?.cancel().catch(() => undefined);
          return { kind: "answered", refused: new Map() };
        }
        return { kind: "answered", refused: HttpSink.refusedIn(await response.text()) };
      }
      const other = HttpSink.otherAnswer(response, batch.length, batchless);
      if (other !== null) {
        // An unread body holds its connection until GC.
        void response.body?.cancel().catch(() => undefined);
        return other;
      }
      const detail = await HttpSink.readHead(response).catch(() => "<unreadable>");
      return { kind: "refused", status, refusal: { kind: `HTTP ${status}`, detail } };
    } catch {
      return { kind: "transient", retryAfterMs: null };
    } finally {
      clearTimeout(timer);
      this.closing.signal.removeEventListener("abort", abort);
    }
  }

  /** Every answer but a 2xx and a refusal of the whole batch. */
  private static otherAnswer(response: Response, size: number, batchless: boolean): Answer | null {
    const { status } = response;
    if (status === 413 && size > 1) return { kind: "too_large" };
    if ((status === 404 || status === 405) && !batchless) return { kind: "no_batch_endpoint" };
    if (status === 429) return { kind: "transient", retryAfterMs: retryAfterMs(response.headers.get("Retry-After")) };
    if (HttpSink.classifyStatus(status) === "transient_failure") return { kind: "transient", retryAfterMs: null };
    return null;
  }

  /** The refused results by `event_id` (SPEC §2.5). An event with no readable
   * result was delivered. */
  private static refusedIn(text: string): Map<string, Refusal> {
    const refused = new Map<string, Refusal>();
    let results: unknown;
    try {
      results = (JSON.parse(text) as { results?: unknown } | null)?.results;
    } catch {
      return refused;
    }
    if (!Array.isArray(results)) return refused;
    const str = (value: unknown): string => (typeof value === "string" ? value : "");
    for (const result of results as { event_id?: unknown; status?: unknown; error?: { code?: unknown; message?: unknown } }[]) {
      if (result?.status !== "refused" || typeof result.event_id !== "string") continue;
      refused.set(result.event_id, { kind: str(result.error?.code) || "no code", detail: str(result.error?.message) });
    }
    return refused;
  }
}
