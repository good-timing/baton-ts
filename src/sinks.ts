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
import { capCodePoints } from "./_text.js";
import { MAX_TIMER_MS, raceDeadline, SHUTDOWN_FLUSH_TIMEOUT_MS, TIMED_OUT } from "./deadline.js";
import { printable, warn } from "./warn.js";
import type { Event } from "./events.js";

const REFUSAL_BODY_MAX_LEN = 500;

export interface Sink {
  /** Hand one event to the sink. Resolves once the sink has accepted it
   * (which may mean buffered, not yet shipped). MUST NOT block the
   * producer on slow downstream destinations. */
  write(event: Event): Promise<void>;
  /** Wait for any buffered events to reach their destination (or be
   * dropped per the sink's policy). No-op for synchronous sinks. */
  flush(): Promise<void>;
  /** Flush + release resources. After `aclose`, `write` rejects. */
  aclose(): Promise<void>;
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
    process.stderr.write(`baton: sink.write failed; event dropped, tool call continues: ${printable(err)}\n`);
  }
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
    if (this.closed) throw new Error("StdoutSink is closed");
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
    if (this.closed) throw new Error("FileSink is closed");
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
    const errors = results.flatMap((r): unknown[] => (r.status === "rejected" ? [r.reason] : []));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "MultiSink fan-out failures");
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
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly circuit: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private overflowWarned = false;
  /** Aborted once `aclose()` returns: nothing Baton started may keep the
   * process alive after the vendor closed it. */
  private readonly closing = new AbortController();
  /** The drain chain's tail when a flush() or aclose() gave up waiting, until it settles. */
  private stalledDrain: Promise<unknown> | null = null;
  private skipWarnedFor: Promise<unknown> | null = null;
  private closeOnce: Promise<void> | undefined;
  private drainChain: Promise<void> = Promise.resolve();
  private beforeExitHandler: (() => void) | null = null;

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
    if (this.closed) throw new Error("HttpSink is closed");
    this.enqueue(event);
    void this.scheduleDrain();
    this.ensureBeforeExitRegistered();
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
    await this.drainWithinBudget("aclose()", ms);
    this.closing.abort();
    if (this.buffer.length > 0) {
      warn(`baton: the sink closed with ${this.buffer.length} event(s) unsent.`);
    }
    if (this.beforeExitHandler) {
      process.off("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = null;
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

  private enqueue(event: Event): void {
    if (this.buffer.length >= this.bufferSize) {
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
   * `beforeExit` entirely: a vendor needing that guarantee must call
   * `aclose()` from their own handler. */
  private ensureBeforeExitRegistered(): void {
    if (this.beforeExitHandler) return;
    this.beforeExitHandler = () => {
      // Node re-fires `beforeExit` once the pass's work is done; one pass only.
      if (this.buffer.length === 0 || this.exitPassRan) return;
      this.drainChain = this.drainChain.then(
        () => this.exitPass(),
        () => this.exitPass(),
      );
    };
    process.on("beforeExit", this.beforeExitHandler);
  }

  /** One attempt per event, no retry, within `shutdownFlushTimeoutMs` in
   * total (SPEC §11.2); what is left is reported, not sent. */
  private async exitPass(): Promise<void> {
    const deadline = Date.now() + this.shutdownFlushTimeoutMs;
    while (this.buffer.length > 0 && this.circuit.canRequest()) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) break;
      const body = this.encode(this.buffer[0]!);
      if (body !== null) {
        const outcome = await this.postOnce(body, Math.min(this.requestTimeoutMs, timeLeft));
        if (outcome === "transient_failure") {
          this.circuit.recordFailure();
          break;
        }
        this.circuit.recordSuccess();
      }
      this.buffer.shift();
    }
    this.exitPassRan = true;
    if (this.buffer.length > 0) {
      warn(`baton: process exiting with ${this.buffer.length} unsent event(s).`);
    }
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
   * logged because it names the field at fault; it is capped because it is a
   * remote server's text landing in the vendor's log. */
  private static async logRefusal(response: Response): Promise<void> {
    // The body read is under the request's timeout signal, so a stalled body
    // logs "<unreadable>" instead of holding the drain.
    const detail = await HttpSink.readHead(response).then(
      (text) => capCodePoints(text, REFUSAL_BODY_MAX_LEN),
      () => "<unreadable>",
    );
    warn(
      `baton: collector REFUSED an event and it has been dropped ` +
        `(HTTP ${response.status}): ${detail} — the event is gone; nothing retries a 4xx.`,
    );
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
        this.buffer.shift();
        this.circuit.recordSuccess();
      } else if (outcome === "unencodable") {
        // Nothing was sent, so the circuit learns nothing about the endpoint.
        this.buffer.shift();
      } else {
        this.circuit.recordFailure();
        return;
      }
    }
    this.exitPassRan = false;
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
      if (outcome === "permanent_failure") await HttpSink.logRefusal(response);
      // An unread body holds its connection until GC.
      else void response.body?.cancel().catch(() => undefined);
      return outcome;
    } catch {
      return "transient_failure";
    } finally {
      clearTimeout(timer);
      this.closing.signal.removeEventListener("abort", abort);
    }
  }
}
