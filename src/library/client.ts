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

import type { Event } from "../events.js";
import {
  AnnotationEventSchema,
  DEFAULT_CONSENT_TOKEN,
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  ToolCallStartEventSchema,
} from "../events.js";
import { parseDsn, selectDsn } from "../dsn.js";
import { captureDisabled, DisabledSink, logDisabled } from "../optout.js";
import { Scrubber } from "../scrub.js";
import { HttpSink, type Sink } from "../sinks.js";
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
import {
  type LibrarySession,
  newSession,
  nextSequence,
  runInSession,
  sessionEnvelope,
  sessionForCall,
} from "./session.js";
import { pythonStrip, type Principal } from "../identity.js";
import type { HeaderInput } from "../integrations/mcp/clientObserved.js";

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
  /** Who the vendor says is calling. */
  principal?: Principal;
  /** What the calling client said about itself. */
  clientInfo?: { name?: string; version?: string };
  /** The request's headers; only registered ones are kept. */
  headers?: HeaderInput;
  /** The vendor's own id for the user request these calls answer. Pass the
   * same value to every block that serves it, and those calls stay one turn. */
  turnId?: string;
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
  typeof value === "string" && pythonStrip(value) !== "";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
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
    if (!this.closedWarned) {
      this.closedWarned = true;
      process.stderr.write("baton: Client is closed; further events are dropped.\n");
    }
    return false;
  }

  /** Never rejects. Tracked so `flush()` can wait for it. */
  emit(build: () => Event): Promise<void> {
    const write = emit(this.sink, build).finally(() => this.pending.delete(write));
    this.pending.add(write);
    return write;
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  scrub(value: unknown, field: ScrubbedField): unknown {
    return scrubOrNull(this.scrubber, value, field);
  }

  annotate(session: LibrarySession, consentToken: string, options: AnnotateOptions): Promise<void> {
    if (!this.live()) return Promise.resolve();
    const sequence = nextSequence();
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
        process.stderr.write(`baton: scrubber threw on a result; that call's end event is dropped: ${String(err)}\n`);
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
    const sequence = nextSequence();
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
    const sequence = nextSequence();
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
    this.#emitError(nextSequence(), ...describeError(err), durationMs);
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
      process.stderr.write(`baton: session values could not be read; using a minted session: ${String(err)}\n`);
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

  /** Wait until every event so far has reached the sink and the sink has flushed. */
  async flush(): Promise<void> {
    await this.#core.settle();
    try {
      await this.#core.sink.flush();
    } catch (err) {
      process.stderr.write(`baton: sink.flush failed: ${String(err)}\n`);
    }
  }

  /** Flush, then close the sink. Later events are dropped. */
  aclose(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    await this.#core.settle();
    this.#core.closed = true;
    try {
      await this.#core.sink.aclose();
    } catch (err) {
      process.stderr.write(`baton: sink.aclose failed: ${String(err)}\n`);
    }
  }
}
