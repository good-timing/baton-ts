/**
 * The library API (SPEC §5.6): `Client` for a vendor whose agents reach it
 * through something other than MCP — a REST API, a skill, or a tool loop in
 * the vendor's own agent. Twin of the Python SDK's `baton.Client`, with the
 * `with` blocks as callbacks:
 *
 *     const client = new Client({ dsn: process.env.BATON_DSN });
 *     app.use((req, res, next) =>
 *       client.session({ sessionId: req.get("x-conversation-id") }, () =>
 *         client.trace({ toolName: req.path, params: req.body }, () => next()),
 *       ),
 *     );
 *
 * Capture never throws into the vendor's code: a callback's own throw is
 * recorded and rethrown unchanged, and every failure of ours is logged and
 * dropped. Only a bad config throws, and only from the constructor.
 */

import { raceDeadline, TIMED_OUT } from "../deadline.js";
import { nextClockSequence } from "../sequence.js";
import type { Event } from "../events.js";
import {
  AnnotationEventSchema,
  DEFAULT_CONSENT_TOKEN,
  SurfaceSnapshotEventSchema,
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  ToolCallStartEventSchema,
} from "../events.js";
import { parseDsn, selectDsn } from "../dsn.js";
import { captureDisabled, DisabledSink, logDisabled } from "../optout.js";
import { Scrubber } from "../scrub.js";
import { boundedSinkCall, callWithin, droppedAfterClose, HttpSink, isSinkClosed, type Sink } from "../sinks.js";
import { PROCESS_DROPS } from "../drops.js";
import { printable } from "../warn.js";
import { uuid7 } from "../uuid7.js";
import { resolveTenantId } from "../integrations/mcp/config.js";
import { emit } from "../integrations/mcp/emit.js";
import {
  errorTypeOf,
  messageOf,
  RESULT_CAPTURE_MODES,
  type ResultCaptureMode,
  scrubbedErrorBody,
  WITHHELD,
} from "../integrations/mcp/errorResult.js";
import { INTENT_SOURCE_LIBRARY } from "../integrations/mcp/llmText.js";
import { isThenable } from "../integrations/mcp/mcpTypes.js";
import { scrubOrNull, type ScrubbedField } from "../integrations/mcp/safeScrub.js";
import { SentSurfaces } from "../integrations/mcp/surface.js";
import {
  type LibrarySession,
  newSession,
  runInSession,
  sessionEnvelope,
  sessionForCall,
} from "./session.js";
import { type ListToolsOptions, serveTools, snapshotPayload, type Surface } from "./surface.js";
import { type Organization, type Principal } from "../identity.js";
import { isBlank } from "../_text.js";
import type { HeaderInput } from "../integrations/mcp/clientObserved.js";
import { isPlainObject } from "../_object.js";

export interface ClientOptions {
  /** The packed connection string from /account. Resolved explicit →
   * `BATON_DSN`; it builds the sink and supplies `vendorId` and `tenantId`. */
  dsn?: string;
  /** Required unless a `dsn` is given. */
  sink?: Sink;
  /** Explicit → `BATON_VENDOR_ID`. Required unless a `dsn` supplies it. */
  vendorId?: string;
  /** Explicit → `BATON_TENANT_ID` → `vendorId`. */
  tenantId?: string;
  /** Explicit → `BATON_CONSENT_TOKEN` → the SDK default. */
  consentToken?: string;
  /** Defaults to `new Scrubber().scrub`; pass `identityScrub` to opt out. */
  scrubber?: (value: unknown) => unknown;
  /** `"off"` sends no result: see `BatonConfig.resultCaptureMode`. */
  resultCaptureMode?: ResultCaptureMode;
}

export interface SessionOptions {
  /** The vendor's own id for the conversation; without one, the block mints one. */
  sessionId?: string;
  /** Who the vendor says is calling: a `Principal`, which may carry its
   * `organization`, or an `Organization` alone when only the company is known.
   * A block with only a company and no `sessionId` is never joined to another
   * (SPEC §11.5.1), so pass your own `sessionId` then. */
  principal?: Principal | Organization;
  /** What the calling client said about itself. */
  clientInfo?: { name?: string; version?: string };
  /** The request's headers; only registered ones are kept. */
  headers?: HeaderInput;
  /** The vendor's own id for the user request these calls answer. Pass the
   * same value to every block that serves it, and those calls stay one turn. */
  turnId?: string;
  /** The request's MCP `_meta`, for a vendor serving MCP itself. It is sent
   * as `runtime_meta`, and a client declaration in it wins over `clientInfo`. */
  meta?: Record<string, unknown>;
}

export interface TraceOptions {
  toolName: string;
  intent?: string;
  expectedOutcome?: string;
  workflow?: string;
  params?: Record<string, unknown>;
  consentToken?: string;
}

export interface AnnotateOptions {
  whatHappened?: string;
  toolName?: string;
  intent?: string;
  expectedOutcome?: string;
  workflow?: string;
  suggestedImprovement?: string;
  context?: Record<string, unknown>;
}

export interface ObservedError {
  /** `errorType` and `errorBody` are derived from it unless given. */
  error?: unknown;
  errorType?: string;
  errorBody?: string;
}

interface Resolved {
  sink: Sink;
  vendorId: string;
  tenantId: string;
  consentToken: string;
  resultCaptureMode: ResultCaptureMode;
}

function fromEnv(name: string): string | undefined {
  const value = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return value ? value : undefined;
}

function resolveConsentToken(explicit: string | undefined): string {
  if (explicit !== undefined && !explicit) {
    throw new Error(
      "Client consentToken was set to an empty string, and events without one " +
        "MUST be rejected by the consumer per SPEC §2.3. Omit it to take the SDK's default.",
    );
  }
  return explicit ?? fromEnv("BATON_CONSENT_TOKEN") ?? DEFAULT_CONSENT_TOKEN;
}

function resolveClientOptions(options: ClientOptions): Resolved {
  const resultCaptureMode = options.resultCaptureMode ?? "full";
  if (!(RESULT_CAPTURE_MODES as readonly string[]).includes(resultCaptureMode)) {
    throw new Error(
      `Client resultCaptureMode ${JSON.stringify(resultCaptureMode)} must be one of ` +
        `${JSON.stringify([...RESULT_CAPTURE_MODES].sort())}.`,
    );
  }
  if (options.scrubber !== undefined && typeof options.scrubber !== "function") {
    throw new Error("Client scrubber must be a function.");
  }
  const dsnString = selectDsn(
    options.dsn,
    {
      vendorId: Boolean(options.vendorId),
      tenantId: Boolean(options.tenantId),
      sink: options.sink !== undefined,
    },
    "Client",
  );
  const consentToken = resolveConsentToken(options.consentToken);
  if (dsnString !== undefined) {
    const dsn = parseDsn(dsnString);
    return {
      sink: new HttpSink(dsn.origin, { apiKey: dsn.key }),
      vendorId: dsn.vendorId,
      tenantId: dsn.tenantId,
      consentToken,
      resultCaptureMode,
    };
  }
  if (options.sink === undefined) {
    throw new Error(
      "Client needs somewhere to send events: pass sink (for example new HttpSink(url, " +
        "{ apiKey }) or new StdoutSink()), or dsn — the packed value from /account, " +
        "which builds the sink for you.",
    );
  }
  const vendorId = options.vendorId || fromEnv("BATON_VENDOR_ID");
  if (!vendorId) {
    throw new Error("Client needs a vendorId, or the BATON_VENDOR_ID environment variable.");
  }
  return {
    sink: options.sink,
    vendorId,
    tenantId: resolveTenantId(options.tenantId || undefined, vendorId),
    consentToken,
    resultCaptureMode,
  };
}

const hasText = (value: string | null | undefined): boolean =>
  typeof value === "string" && !isBlank(value);

/** `[error_type, error_body]` of a thrown value. Never throws: a vendor's
 * error can be any value, including one whose getters throw. */
function describeError(err: unknown): [string, string] {
  let type = "Error";
  let body = "";
  // Each read is separate, so a throwing message getter still leaves the type.
  try {
    type = errorTypeOf(err);
  } catch {
    // unreadable
  }
  try {
    body = messageOf(err) || (err instanceof Error && typeof err.stack === "string" ? err.stack : "");
  } catch {
    // unreadable
  }
  return [type, body];
}

/** A wrapped function's arguments as `params`: one plain-object argument is
 * a tool's named arguments, as on MCP; anything else is kept as a list. */
function paramsOf(args: readonly unknown[]): Record<string, unknown> {
  if (args.length === 1 && isPlainObject(args[0])) return args[0];
  return args.length === 0 ? {} : { args };
}

/** What a client holds that its traces read. */
class Core {
  closed = false;
  private readonly pending = new Set<Promise<void>>();
  private closedWarned = false;
  // A snapshot describes the server, so it takes no block's session,
  // principal or client: SPEC §11.5.1's join must not count it.
  private readonly surfaceSessionId = uuid7();
  private readonly sentSurfaces = new SentSurfaces();

  readonly sink: Sink;
  readonly vendorId: string;
  readonly tenantId: string;
  readonly consentToken: string;
  readonly resultCaptureMode: ResultCaptureMode;
  readonly scrubber: (value: unknown) => unknown;
  readonly disabled: boolean;

  constructor(resolved: Resolved & { scrubber: (value: unknown) => unknown; disabled: boolean }) {
    this.sink = resolved.sink;
    this.vendorId = resolved.vendorId;
    this.tenantId = resolved.tenantId;
    this.consentToken = resolved.consentToken;
    this.resultCaptureMode = resolved.resultCaptureMode;
    this.scrubber = resolved.scrubber;
    this.disabled = resolved.disabled;
  }

  /** The envelope members every event of `session` shares. Call inside a
   * build thunk, so `captured_at` is the build time. */
  envelope(session: LibrarySession, consentToken: string, sequence: number): Record<string, unknown> {
    return {
      tenant_id: this.tenantId,
      vendor_id: this.vendorId,
      ...sessionEnvelope(session),
      sequence_number: sequence,
      captured_at: new Date().toISOString(),
      consent_token: consentToken,
    };
  }

  /** False when nothing may be emitted: the off switch, or a closed client. */
  live(): boolean {
    if (this.disabled) return false;
    if (!this.closed) return true;
    PROCESS_DROPS.add("after_close");
    if (!this.closedWarned) {
      this.closedWarned = true;
      process.stderr.write("baton: Client is closed; further events are dropped.\n");
    }
    return false;
  }

  /** Never rejects. Tracked so `flush()` can wait for it. */
  emit(build: () => Event): Promise<void> {
    return this.track(emit(this.sink, build));
  }

  private track(work: Promise<void>): Promise<void> {
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  /** Sends `surface` unless this client already has. Never rejects; a failed
   * write unmarks it, so the next `listTools` tries again. A surface that does
   * not fit the schema stays marked: it would fail the same way every time. */
  sendSurface(surface: Surface): Promise<void> {
    if (this.sentSurfaces.wasSent(surface.digest) || !this.live()) return Promise.resolve();
    this.sentSurfaces.mark(surface.digest);
    let event: Event;
    try {
      event = SurfaceSnapshotEventSchema.parse({
        tenant_id: this.tenantId,
        vendor_id: this.vendorId,
        session_id: this.surfaceSessionId,
        session_id_origin: "minted",
        sequence_number: nextClockSequence(),
        captured_at: new Date().toISOString(),
        consent_token: this.consentToken,
        payload: snapshotPayload(surface),
      });
    } catch (err) {
      PROCESS_DROPS.add("encode_failed");
      process.stderr.write(`baton: surface snapshot dropped; it does not fit the schema: ${printable(err)}\n`);
      return Promise.resolve();
    }
    return this.track(
      (async () => {
        try {
          await this.sink.write(event);
        } catch (err) {
          if (isSinkClosed(err)) return droppedAfterClose(this.sink);
          process.stderr.write(`baton: surface snapshot not sent; will retry: ${printable(err)}\n`);
          this.sentSurfaces.unmark(surface.digest);
        }
      })(),
    );
  }

  /** Waits up to `ms` for pending events to reach the sink; with `untilEmpty`,
   * also for ones emitted while it waits. A write still pending when time runs
   * out is not waited on again, so one stuck write costs one wait. */
  async settleWithin(ms: number, untilEmpty: boolean): Promise<void> {
    const deadline = performance.now() + ms;
    do {
      const waiting = [...this.pending];
      if ((await raceDeadline(Promise.allSettled(waiting), deadline - performance.now())) === TIMED_OUT) {
        const left = waiting.filter((write) => this.pending.delete(write));
        // Lost only for close: after a flush the write may still finish.
        if (untilEmpty) PROCESS_DROPS.add("unsent_at_close", left.length);
        return;
      }
    } while (untilEmpty && this.pending.size > 0);
  }

  scrub(value: unknown, field: ScrubbedField): unknown {
    return scrubOrNull(this.scrubber, value, field);
  }

  annotate(session: LibrarySession, consentToken: string, options: AnnotateOptions): Promise<void> {
    if (!this.live()) return Promise.resolve();
    const sequence = nextClockSequence();
    // The text fields are scrubbed bare inside the thunk: an annotation is one
    // report, so a scrubber throw drops it whole, as on the MCP path.
    /* eslint-disable no-restricted-syntax -- inside the emit() build thunk */
    const text = (value: string | undefined): string | null =>
      value === undefined ? null : (this.scrubber(value) as string | null);
    return this.emit(() =>
      AnnotationEventSchema.parse({
        ...this.envelope(session, consentToken, sequence),
        payload: {
          intent: text(options.intent),
          expected_outcome: text(options.expectedOutcome),
          what_happened: hasText(options.whatHappened) ? text(options.whatHappened) : null,
          tool_name: options.toolName ? text(options.toolName) : (options.toolName ?? null),
          workflow: text(options.workflow),
          suggested_improvement: text(options.suggestedImprovement),
          context:
            options.context && Object.keys(options.context).length > 0
              ? this.scrub(options.context, "context")
              : null,
        },
      }),
    );
    /* eslint-enable no-restricted-syntax */
  }
}

const UNSET = Symbol("unset");
// `observed()` ran and the result was deliberately not kept (resultCaptureMode "off").
const WITHHELD_RESULT = Symbol("withheld");
// The scrubber threw on the result. Re-thrown inside the build thunk so the
// end event is dropped rather than sent with a result the tool never returned.
const SCRUB_FAILED = Symbol("scrubFailed");

// Set by `Trace`'s static block, so only `Client` can start, end or fail a trace.
let runTrace: <T>(core: Core, session: LibrarySession, options: TraceOptions, fn: (trace: Trace) => T) => T;

/** One traced call, handed to the `client.trace()` callback. */
export class Trace {
  readonly #core: Core;
  readonly #session: LibrarySession;
  readonly #options: TraceOptions;
  readonly #consentToken: string;
  readonly #callId = uuid7();
  #startedAt = 0;
  #result: unknown = UNSET;
  #error: { type: string; body: string } | null = null;
  #observedWarned = false;

  private constructor(core: Core, session: LibrarySession, options: TraceOptions) {
    this.#core = core;
    this.#session = session;
    this.#options = options;
    this.#consentToken = options.consentToken || core.consentToken;
  }

  /** The session this call's events carry. */
  get sessionId(): string {
    return this.#session.sessionId;
  }

  /** Record the outcome. Without a call, the callback's return value is the
   * result. `observed(undefined, { error })` records a failure the callback
   * caught and did not rethrow. The last call wins. */
  observed(result?: unknown, failure?: ObservedError): this {
    if ((this.#result !== UNSET || this.#error !== null) && !this.#observedWarned) {
      this.#observedWarned = true;
      process.stderr.write("baton: Trace.observed() called more than once; the last call wins.\n");
    }
    this.#result = UNSET;
    this.#error = null;
    if (this.#core.disabled) return this;
    let errorType = failure?.errorType;
    let errorBody = failure?.errorBody;
    if (failure?.error !== undefined) {
      const [derivedType, derivedBody] = describeError(failure.error);
      errorType ||= derivedType;
      errorBody ||= derivedBody;
    }
    if (errorType !== undefined || errorBody !== undefined) {
      this.#error = { type: errorType || "Error", body: errorBody ?? "" };
    } else if (this.#core.resultCaptureMode === WITHHELD) {
      // Decided here, so a withheld result never reaches the scrubber (SPEC §7).
      this.#result = WITHHELD_RESULT;
    } else {
      // Scrubbed now, so a result object the caller changes later is recorded
      // as it was when observed.
      try {
        // eslint-disable-next-line no-restricted-syntax -- the throw is caught here and parks SCRUB_FAILED, which drops the end event
        this.#result = this.#core.scrubber(result);
      } catch (err) {
        process.stderr.write(`baton: scrubber threw on a result; that call's end event is dropped: ${printable(err)}\n`);
        this.#result = SCRUB_FAILED;
      }
    }
    return this;
  }

  /** Report on this call, in its session. */
  annotate(options: AnnotateOptions): Promise<void> {
    return this.#core.annotate(this.#session, this.#consentToken, options);
  }

  #envelope(sequence: number): Record<string, unknown> {
    return { ...this.#core.envelope(this.#session, this.#consentToken, sequence), call_id: this.#callId };
  }

  #durationMs(): number {
    return Math.trunc(performance.now() - this.#startedAt);
  }

  #start(): void {
    this.#startedAt = performance.now();
    if (!this.#core.live()) return;
    const sequence = nextClockSequence();
    const o = this.#options;
    // Fail-open per field, outside the thunk: a scrubber throw here must not
    // drop the start event and leave the call's end unpaired.
    const params = o.params === undefined ? {} : (this.#core.scrub(o.params, "params") ?? {});
    const textOf = (value: string | undefined, field: ScrubbedField): string | null => {
      const scrubbed = value === undefined ? null : this.#core.scrub(value, field);
      return typeof scrubbed === "string" ? scrubbed : null;
    };
    const intent = textOf(o.intent, "intent");
    const expected = textOf(o.expectedOutcome, "expected_outcome");
    const workflow = textOf(o.workflow, "workflow");
    const stated = [intent, expected, workflow].some(hasText);
    void this.#core.emit(() =>
      ToolCallStartEventSchema.parse({
        ...this.#envelope(sequence),
        payload: {
          tool_name: o.toolName,
          params,
          call_intent: intent,
          call_expected: expected,
          call_workflow: workflow,
          intent_source: stated ? INTENT_SOURCE_LIBRARY : null,
        },
      }),
    );
  }

  #end(value: unknown): void {
    const durationMs = this.#durationMs();
    if (!this.#core.live()) return;
    if (this.#result === UNSET && this.#error === null) this.observed(value);
    const sequence = nextClockSequence();
    const error = this.#error;
    if (error !== null) {
      this.#emitError(sequence, error.type, error.body, durationMs);
      return;
    }
    const result = this.#result;
    void this.#core.emit(() => {
      if (result === SCRUB_FAILED) throw new Error("the scrubber threw on this result");
      return ToolCallEndEventSchema.parse({
        ...this.#envelope(sequence),
        payload: {
          tool_name: this.#options.toolName,
          duration_ms: durationMs,
          ...(result === WITHHELD_RESULT
            ? { result: null, result_capture: WITHHELD }
            : { result }),
        },
      });
    });
  }

  #fail(err: unknown): void {
    const durationMs = this.#durationMs();
    if (!this.#core.live()) return;
    this.#emitError(nextClockSequence(), ...describeError(err), durationMs);
  }

  #emitError(sequence: number, type: string, body: string, durationMs: number): void {
    void this.#core.emit(() =>
      ToolCallErrorEventSchema.parse({
        ...this.#envelope(sequence),
        payload: {
          tool_name: this.#options.toolName,
          error_type: type,
          error_body: scrubbedErrorBody(this.#core.scrubber, body),
          duration_ms: durationMs,
          result: null,
        },
      }),
    );
  }

  static {
    runTrace = <T>(core: Core, session: LibrarySession, options: TraceOptions, fn: (trace: Trace) => T): T => {
      const trace = new Trace(core, session, options);
      trace.#start();
      let value: T;
      try {
        value = fn(trace);
      } catch (err) {
        trace.#fail(err);
        throw err;
      }
      if (!isThenable(value)) {
        trace.#end(value);
        return value;
      }
      return Promise.resolve(value).then(
        (resolved) => {
          trace.#end(resolved);
          return resolved;
        },
        (err: unknown) => {
          trace.#fail(err);
          throw err;
        },
      ) as T;
    };
  }
}

/** The library API's client. One per process. */
export class Client {
  readonly #core: Core;
  #closing: Promise<void> | undefined;

  constructor(options: ClientOptions = {}) {
    const switchName = captureDisabled();
    let resolved: Resolved;
    if (switchName !== null) {
      // Off means never throw, so nothing is validated; a sink the caller
      // passed is kept so `aclose()` still releases it.
      logDisabled(switchName, "Client");
      resolved = {
        sink: options.sink ?? new DisabledSink(),
        vendorId: "",
        tenantId: "",
        consentToken: DEFAULT_CONSENT_TOKEN,
        resultCaptureMode: "full",
      };
    } else {
      resolved = resolveClientOptions(options);
    }
    this.#core = new Core({
      ...resolved,
      scrubber: options.scrubber ?? new Scrubber().scrub,
      disabled: switchName !== null,
    });
  }

  /** Run `fn` with one session, principal, client and turn for every
   * `trace()` and `annotate()` inside it, including after its awaits. Open
   * one per request or conversation. Returns what `fn` returns. */
  session<T>(options: SessionOptions, fn: () => T): T {
    let block: LibrarySession;
    try {
      block = newSession(options, this.#core.scrubber, this.#core.disabled);
    } catch (err) {
      process.stderr.write(`baton: session values could not be read; using a minted session: ${printable(err)}\n`);
      block = newSession({}, this.#core.scrubber, this.#core.disabled);
    }
    return runInSession(this, block, fn);
  }

  /** Run `fn` as one traced tool call and return what it returns. When `fn`
   * returns a promise or other thenable, the call ends when it settles, and
   * what comes back is a new native Promise of the same value: `then` is
   * called exactly once, so a lazy query builder is not run twice. A throw or
   * rejection is recorded and passed on unchanged. */
  trace<T>(options: TraceOptions, fn: (trace: Trace) => T): T {
    // `?? {}` for a JavaScript caller: missing options must not throw into its code.
    return runTrace(this.#core, sessionForCall(this), options ?? ({} as TraceOptions), fn);
  }

  /** `fn`, traced on every call. A single plain-object argument is sent as
   * `params`, as an MCP tool's arguments are; other arguments as
   * `{ args: [...] }`, unless `options.params` is given. */
  wrap<A extends unknown[], R>(options: string | TraceOptions, fn: (...args: A) => R): (...args: A) => R {
    const base: TraceOptions = typeof options === "string" ? { toolName: options } : (options ?? {});
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the wrapper keeps its own `this` for `fn`
    const client = this;
    return function (this: unknown, ...args: A): R {
      return client.trace({ ...base, params: base.params ?? paramsOf(args) }, () => fn.apply(this, args));
    };
  }

  /** Emit an annotation in the open `session()` block, or in a session of its
   * own outside one. To report on a traced call, use `trace.annotate()`. */
  annotate(options: AnnotateOptions & { consentToken?: string }): Promise<void> {
    const given = options ?? {};
    return this.#core.annotate(sessionForCall(this), given.consentToken || this.#core.consentToken, given);
  }

  /** `tools`, the vendor's own `tools/list` entries, with `user_goal` added
   * to each `inputSchema` as `withBaton` adds it, and a `surface_snapshot`
   * of `tools` as passed, sent once per distinct surface. For a vendor
   * serving MCP itself (SPEC §5.6).
   *
   * Pass the tools before anything of Baton's is added, so the snapshot
   * describes the vendor's own surface. `options` holds the vendor's own
   * `initialize` values. The input is not changed. Never rejects over the
   * tool list: one it cannot read is returned as it came. Does not wait for
   * the snapshot to be sent; `flush()` does. */
  async listTools<T>(tools: readonly T[], options: ListToolsOptions = {}): Promise<T[]> {
    if (this.#core.disabled) return tools as T[];
    const { served, surface } = serveTools(tools, options);
    if (surface !== null) void this.#core.sendSurface(surface);
    return served;
  }

  /** Wait for events so far to reach the sink, then flush it. Never rejects;
   * returns within the sink's shutdown budget plus 250 ms (SPEC §11.2 rule 7). */
  async flush(): Promise<void> {
    await this.#settleThen("flush");
  }

  /** Flush, then close the sink. Later events are dropped. */
  aclose(): Promise<void> {
    this.#closing ??= this.#settleThen("aclose");
    return this.#closing;
  }

  /** One budget: events in flight get until its end to reach the sink, then
   * the sink gets the time left. */
  async #settleThen(method: "flush" | "aclose"): Promise<void> {
    await boundedSinkCall(this.#core.sink, method, async (budgetMs) => {
      const deadline = performance.now() + budgetMs;
      await this.#core.settleWithin(budgetMs, method === "aclose");
      if (method === "aclose") this.#core.closed = true;
      await callWithin(this.#core.sink, method, Math.max(0, deadline - performance.now()));
    });
  }
}
