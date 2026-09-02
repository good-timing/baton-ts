/**
 * Sinks — where Baton events go after the SDK captures them.
 *
 * A `Sink` is the egress side of the SDK; `withBaton` hands fully-formed
 * `Event` envelopes to a sink and the sink decides what to do with them.
 *
 * Two sinks ship, mirroring `sinks.py`'s core pair:
 *
 * - `StdoutSink` — JSONL to a writable stream (default `process.stderr`,
 *   for the same reason as Python: MCP stdio transport reserves stdout for
 *   JSON-RPC framing).
 * - `HttpSink` — POST to any HTTP endpoint with bearer auth; bounded
 *   buffer, retry with backoff, circuit breaker. This is the contract a
 *   Console or any compatible collector consumes.
 *
 * `FileSink` / `MultiSink` are deferred per design-notes/typescript_sdk.md
 * ("HttpSink + StdoutSink covers all real use cases") — add them if a real
 * need shows up rather than porting them speculatively.
 */

import type { Event } from "./events.js";

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
    process.stderr.write(`baton: sink.write failed; event dropped, tool call continues: ${String(err)}\n`);
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
// HttpSink — POST + bearer + bounded buffer + retry + circuit breaker
// =============================================================================

type SendOutcome = "success" | "permanent_failure" | "transient_failure";

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
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly circuit: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private overflowWarned = false;
  private closed = false;
  private drainChain: Promise<void> = Promise.resolve();
  private beforeExitHandler: (() => void) | null = null;

  constructor(url: string, options: HttpSinkOptions) {
    this.url = url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.bufferSize = options.bufferSize ?? 1000;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 100;
    this.backoffMaxMs = options.backoffMaxMs ?? 5000;
    this.circuit = new CircuitBreaker(
      options.circuitBreakerThreshold ?? 5,
      options.circuitBreakerResetMs ?? 30_000,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async write(event: Event): Promise<void> {
    if (this.closed) throw new Error("HttpSink is closed");
    this.enqueue(event);
    void this.scheduleDrain();
    this.ensureBeforeExitRegistered();
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    await this.scheduleDrain();
  }

  async aclose(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    if (this.beforeExitHandler) {
      process.off("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = null;
    }
  }

  private enqueue(event: Event): void {
    if (this.buffer.length >= this.bufferSize) {
      if (!this.overflowWarned) {
        process.emitWarning(
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
   * explicit `aclose()`. Node re-runs `beforeExit` if new async work is
   * scheduled during it, so an in-flight flush here can complete normally —
   * unlike Python's synchronous `atexit`, no separate sync-client fallback
   * is needed. Real residual gap, not fixable in-process: SIGKILL, or
   * SIGTERM with no installed handler, skip `beforeExit` entirely. A vendor
   * needing that guarantee must call `aclose()` from their own handler. */
  private ensureBeforeExitRegistered(): void {
    if (this.beforeExitHandler) return;
    this.beforeExitHandler = () => {
      void this.flush();
    };
    process.on("beforeExit", this.beforeExitHandler);
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

  private async drainLocked(): Promise<void> {
    while (this.buffer.length > 0) {
      if (!this.circuit.canRequest()) return;
      const event = this.buffer[0]!;
      const outcome = await this.sendWithRetry(event);
      if (outcome === "success" || outcome === "permanent_failure") {
        this.buffer.shift();
        this.circuit.recordSuccess();
      } else {
        this.circuit.recordFailure();
        return;
      }
    }
  }

  private async sendWithRetry(event: Event): Promise<SendOutcome> {
    const url = this.events_url();
    const headers = this.authHeaders();
    const body = JSON.stringify(event);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(url, { method: "POST", headers, body });
        const outcome = HttpSink.classifyStatus(response.status);
        if (outcome !== "transient_failure") return outcome;
      } catch {
        // network error — fall through to retry/backoff below
      }
      if (attempt < this.maxRetries) {
        const backoff = Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    return "transient_failure";
  }
}
