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

import * as asyncHooks from "node:async_hooks";
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
import { boundedSinkCall, droppedAfterClose, HttpSink, offTheCall, safeWrite, type Sink } from "../sinks.js";
import { PROCESS_DROPS } from "../drops.js";
import { printable, stderrLine } from "../warn.js";
import { uuid7 } from "../uuid7.js";
import {
  consoleCaptureSettings,
  consoleDroppedOnWorkers,
  resolveTenantId,
  validateReportMode,
  validateSettings,
} from "../integrations/mcp/config.js";
import {
  candidateNeedsConsole,
  CaptureSettings,
  type ReportMode,
  type SettingsMode,
} from "../integrations/mcp/captureSettings.js";
import { deriveAnnotationToolName, toolNameForDisplayName } from "../integrations/mcp/annotationName.js";
import { emit } from "../integrations/mcp/emit.js";
import {
  errorTypeOf,
  messageOf,
  resultDerivedFields,
  returnedErrorFields,
  TOOL_ERROR_TYPE,
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
  inBlock,
  type LibrarySession,
  newSession,
  runInSession,
  sessionEnvelope,
  sessionForCall,
} from "./session.js";
import {
  type Call,
  isToolErrorResult,
  JSONRPC_ERROR_TYPE,
  jsonRpcError,
  readRequest,
  type Report,
  type Request,
  resultOf,
  Serving,
  TOOL_CALL,
  TOOL_LIST,
  traceOptions,
  type VendorTools,
  withoutUserGoal,
} from "./serve.js";
import { reportTool } from "./reportTool.js";
import { type ListToolsOptions, serveTools, snapshotPayload, type Surface } from "./surface.js";
import { type Organization, type Principal } from "../identity.js";
import { isBlank } from "../_text.js";
import type { HeaderInput } from "../integrations/mcp/clientObserved.js";
import { isPlainObject, isRecord } from "../_object.js";

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
  /** `"console"` takes each caller's capture settings from the Console's
   * Capture page, read with the `dsn`'s key (experimental). */
  settings?: SettingsMode;
  /** How often the Console's settings are read, in milliseconds. Default 60000, at least 15000. */
  settingsRefreshMs?: number;
  /** Whether `serve()` adds the report tool. Default `"on"` with
   * `settings: "console"`, else `"off"`. */
  reportMode?: ReportMode;
  /** The name Baton's report text gives this server. Defaults to the server id. */
  vendorDisplayName?: string;
  /** The vendor's tools, or a function returning them, so `serve()` knows
   * them before it serves a list: pass them when a tool declares its own
   * `user_goal` or has the report tool's name. Read once, at the first request. */
  tools?: VendorTools;
}

export interface SessionOptions {
  /** The vendor's own id for the conversation; without one, the block mints one. */
  sessionId?: string;
  /** Who the vendor says is calling: a `Principal`, which may carry its
   * `organization`, or an `Organization` alone when only the company is known.
   * A block with only a company and no `sessionId` gets a session of its own,
   * so pass your own `sessionId` to keep a conversation's blocks together. */
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

export type ServeOptions = Pick<SessionOptions, "principal" | "headers" | "sessionId">;

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
  captureSettings?: CaptureSettings;
  report?: Report;
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
  validateServeOptions(options);
  const dsnString = selectDsn(
    options.dsn,
    {
      vendorId: Boolean(options.vendorId),
      tenantId: Boolean(options.tenantId),
      sink: options.sink !== undefined,
    },
    "Client",
  );
  if (options.settings === "console" && dsnString === undefined) {
    throw new Error('Client settings: "console" reads the Capture page with the dsn\'s key, so it needs a dsn.');
  }
  candidateNeedsConsole(options.settings);
  // As withBaton: on with Console settings unless the code says otherwise.
  const reportOn = (options.reportMode ?? (options.settings === "console" ? "on" : "off")) === "on";
  const consentToken = resolveConsentToken(options.consentToken);
  if (dsnString !== undefined) {
    const dsn = parseDsn(dsnString);
    const consoleSettings = options.settings === "console" && !consoleDroppedOnWorkers(options.settings);
    return {
      sink: new HttpSink(dsn.origin, { apiKey: dsn.key }),
      vendorId: dsn.vendorId,
      tenantId: dsn.tenantId,
      consentToken,
      resultCaptureMode,
      ...(consoleSettings
        ? {
            captureSettings: consoleCaptureSettings(dsn, options.settingsRefreshMs),
          }
        : {}),
      ...(reportOn ? { report: serveReport(dsn.vendorId, options.vendorDisplayName) } : {}),
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
    ...(reportOn ? { report: serveReport(vendorId, options.vendorDisplayName) } : {}),
  };
}

function validateServeOptions(options: ClientOptions): void {
  validateSettings(options, "Client");
  validateReportMode(options, "Client");
  if (options.tools !== undefined && !Array.isArray(options.tools) && typeof options.tools !== "function") {
    throw new Error("Client tools must be an array of tools or a function that returns one.");
  }
}

/** The report tool `serve()` adds, named as the adapters name it, falling
 * back to `<vendorId>_annotate`. */
function serveReport(vendorId: string, displayName: string | undefined): Report {
  const display = displayName === undefined || isBlank(displayName) ? vendorId : displayName;
  const name = deriveAnnotationToolName(vendorId, toolNameForDisplayName(display));
  return { tool: reportTool({ vendorDisplayName: display, name }), vendorDisplayName: display };
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
  // A snapshot describes the server, so it takes no block's session,
  // principal or client (SPEC §5.6 rule 7).
  private readonly surfaceSessionId = uuid7();
  private readonly sentSurfaces = new SentSurfaces();

  readonly sink: Sink;
  readonly vendorId: string;
  readonly tenantId: string;
  readonly consentToken: string;
  readonly resultCaptureMode: ResultCaptureMode;
  readonly scrubber: (value: unknown) => unknown;
  readonly disabled: boolean;
  readonly settings: CaptureSettings | undefined;

  constructor(resolved: Resolved & { scrubber: (value: unknown) => unknown; disabled: boolean }) {
    this.sink = offTheCall(resolved.sink);
    this.vendorId = resolved.vendorId;
    this.tenantId = resolved.tenantId;
    this.consentToken = resolved.consentToken;
    this.resultCaptureMode = resolved.resultCaptureMode;
    this.scrubber = resolved.scrubber;
    this.disabled = resolved.disabled;
    this.settings = resolved.captureSettings;
  }

  modeFor(session: LibrarySession): ResultCaptureMode {
    return session.settings?.resultCaptureMode ?? this.resultCaptureMode;
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

  errorBody(text: string): string {
    return scrubbedErrorBody(this.scrubber, text);
  }

  /** False when nothing may be emitted: the off switch, or a closed client. */
  live(): boolean {
    if (this.disabled) return false;
    if (!this.closed) return true;
    // Keyed on the sink, so an event its queue refused while closing and one
    // refused here share one warning (SPEC §11.2 rule 7).
    droppedAfterClose(this.sink);
    return false;
  }

  /** Never rejects. */
  emit(build: () => Event): Promise<void> {
    return emit(this.sink, build);
  }

  /** Sends `surface` unless this client already has. Never rejects. The
   * write only queues, so a surface counts as sent once queued. */
  sendSurface(surface: Surface, seam?: () => Record<string, unknown>, serverOverlay: string | null = null): Promise<void> {
    if (this.sentSurfaces.wasSent(surface.digest, serverOverlay) || !this.live()) return Promise.resolve();
    this.sentSurfaces.mark(surface.digest, serverOverlay);
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
        payload: snapshotPayload(surface, seam?.()),
      });
    } catch (err) {
      PROCESS_DROPS.add("encode_failed");
      stderrLine(`baton: surface snapshot dropped; it does not fit the schema: ${printable(err)}`);
      return Promise.resolve();
    }
    return safeWrite(this.sink, event);
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

/** `serve()`'s failure fields, already decided by the caller's mode and scrubbed. */
export interface FailureFields {
  error_body: string;
  result: unknown;
  result_capture?: string;
}

// Set by `Trace`'s static block, so only `serve()` records a failure it decided.
let observeFailure: (trace: Trace, errorType: string, fields: FailureFields, failureKind?: string) => void;

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
  #failure: (Omit<FailureFields, "error_body"> & { failure_kind?: string }) | null = null;
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
      stderrLine("baton: Trace.observed() called more than once; the last call wins.");
    }
    this.#result = UNSET;
    this.#error = null;
    this.#failure = null;
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
    } else if (this.#core.modeFor(this.#session) === WITHHELD) {
      // Decided here, so a withheld result never reaches the scrubber (SPEC §7).
      this.#result = WITHHELD_RESULT;
    } else {
      // Scrubbed now, so a result object the caller changes later is recorded
      // as it was when observed.
      try {
        // eslint-disable-next-line no-restricted-syntax -- the throw is caught here and parks SCRUB_FAILED, which drops the end event
        this.#result = this.#core.scrubber(result);
      } catch (err) {
        stderrLine(`baton: scrubber threw on a result; that call's end event is dropped: ${printable(err)}`);
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
    const [type, body] = describeError(err);
    // A raised message may quote what the tool fetched; text passed to
    // observed() by name is the vendor's choice and is kept (SPEC §11.4.3).
    if (this.#core.modeFor(this.#session) === WITHHELD) {
      this.#failure = { result: null, result_capture: WITHHELD };
      this.#emitError(nextClockSequence(), type, "", durationMs);
      return;
    }
    this.#emitError(nextClockSequence(), type, body, durationMs);
  }

  #emitError(sequence: number, type: string, body: string, durationMs: number): void {
    const failure = this.#failure;
    void this.#core.emit(() =>
      ToolCallErrorEventSchema.parse({
        ...this.#envelope(sequence),
        payload: {
          tool_name: this.#options.toolName,
          error_type: type,
          error_body: failure === null ? scrubbedErrorBody(this.#core.scrubber, body) : body,
          duration_ms: durationMs,
          result: null,
          ...failure,
        },
      }),
    );
  }

  static {
    observeFailure = (trace, errorType, fields, failureKind) => {
      trace.#result = UNSET;
      trace.#error = { type: errorType, body: fields.error_body };
      trace.#failure = {
        result: fields.result,
        ...(fields.result_capture === undefined ? {} : { result_capture: fields.result_capture }),
        ...(failureKind === undefined ? {} : { failure_kind: failureKind }),
      };
    };
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

/** That `owner`'s `serve()` is running the vendor's dispatch for a request
 * where it already does what `flags` names. Work the dispatch starts keeps
 * the store, so the mark ends rather than the store. */
class Mark {
  active = true;
  constructor(
    readonly owner: object,
    readonly flags: string,
  ) {}
}

const inDispatch = new asyncHooks.AsyncLocalStorage<Mark | null>();

async function dispatched(
  dispatch: (message: unknown) => unknown,
  message: unknown,
  mark: Mark | null = null,
): Promise<unknown> {
  try {
    return await inDispatch.run(mark, () => dispatch(message));
  } finally {
    if (mark !== null) mark.active = false;
  }
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  return message === undefined ? "" : (JSON.stringify(message) ?? "");
}

/** A scrubber that throws loses the error's text, not the fact that the call failed. */
function fieldsOrEmpty(build: () => FailureFields): FailureFields {
  try {
    return build();
  } catch (err) {
    stderrLine(`baton: the scrubber threw on an error answer; its text is dropped: ${printable(err)}`);
    return { error_body: "", result: null };
  }
}

const stopWhenDropped =
  typeof FinalizationRegistry === "function" ? new FinalizationRegistry<CaptureSettings>((s) => s.stop()) : undefined;

/** The library API's client. One per process. */
export class Client {
  readonly #core: Core;
  readonly #serving: Serving;
  readonly #doubleWiringLogged = new Set<string>();
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
    this.#serving = new Serving(resolved.report, resolved.captureSettings, switchName === null ? options.tools : undefined);
    if (resolved.captureSettings !== undefined) {
      resolved.captureSettings.start();
      // A client dropped without aclose() must not read the Console forever.
      stopWhenDropped?.register(this, resolved.captureSettings);
    }
  }

  /** Run `fn` with one session, principal, client and turn for every
   * `trace()` and `annotate()` inside it, including after its awaits. Open
   * one per request or conversation. Returns what `fn` returns. */
  session<T>(options: SessionOptions, fn: () => T): T {
    let block: LibrarySession;
    try {
      block = newSession(options, this.#core.scrubber, this.#core.disabled);
    } catch (err) {
      stderrLine(`baton: session values could not be read; using a minted session: ${printable(err)}`);
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
    this.#flagDoubleWiring("trace");
    // `?? {}` for a JavaScript caller: missing options must not throw into its code.
    return runTrace(this.#core, sessionForCall(this, this.#core.settings), options ?? ({} as TraceOptions), fn);
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
    return this.#core.annotate(
      sessionForCall(this, this.#core.settings),
      given.consentToken || this.#core.consentToken,
      given,
    );
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
    this.#flagDoubleWiring("listTools");
    if (this.#core.disabled) return tools as T[];
    const { served, surface } = serveTools(tools, options);
    if (surface !== null) void this.#core.sendSurface(surface);
    return served;
  }

  /** Answer one MCP JSON-RPC `message` with `dispatch`, the vendor's own
   * function from message to answer, and Baton around it (SPEC §5.6).
   * Experimental.
   *
   * `initialize` gets Baton's instructions. `tools/list` gets `user_goal` and
   * the report tool, under the caller's Console settings, and sends the
   * snapshot. `tools/call` is traced, with `user_goal` removed before
   * `dispatch` sees it; Baton answers the report tool and a tool the caller's
   * overlay hides itself. Anything else goes to `dispatch` as it came.
   *
   * `options` are as on `session()`. A process learns the vendor's tools from
   * the lists it serves. Until it has, a call loses `user_goal` and the report
   * tool's name is Baton's; pass the `tools` option when a tool declares its
   * own `user_goal` or has the report tool's name. `dispatch` is called at
   * most once, and what it returns or throws comes back unchanged apart from
   * Baton's additions. A failure in Baton's own work is logged, never thrown. */
  serve(message: unknown, dispatch: (message: unknown) => unknown, options: ServeOptions = {}): Promise<unknown> {
    // Baton's own session and trace here are not the vendor's, even inside
    // another serve()'s dispatch.
    return inDispatch.run(null, () => this.#serve(message, dispatch, options ?? {}));
  }

  async #serve(message: unknown, dispatch: (message: unknown) => unknown, options: ServeOptions): Promise<unknown> {
    const request = this.#request(message);
    if (request === null) return dispatched(dispatch, message);
    const settings = this.#core.settings;
    if (settings !== undefined && !settings.isReady) await settings.ready;
    const handle = (): Promise<unknown> => this.#handle(request, message as Record<string, unknown>, dispatch);
    // A block the vendor opened around serve() is kept unless this call names its own caller or session.
    const { principal, headers, sessionId } = options;
    if (inBlock(this) && principal === undefined && headers === undefined && sessionId === undefined) return handle();
    const values: SessionOptions = {
      ...(principal === undefined ? {} : { principal }),
      ...(headers === undefined ? {} : { headers }),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    try {
      if (isRecord(request.params._meta)) values.meta = request.params._meta;
      if (request.method === "initialize" && isRecord(request.params.clientInfo)) {
        values.clientInfo = request.params.clientInfo;
      }
    } catch {
      // A value Baton cannot read is left out of the session.
    }
    return this.session(values, handle);
  }

  async #handle(
    request: Request,
    message: Record<string, unknown>,
    dispatch: (message: unknown) => unknown,
  ): Promise<unknown> {
    let session: LibrarySession;
    let call: Call | null = null;
    try {
      session = sessionForCall(this, this.#core.settings);
      if (request.method === TOOL_CALL) call = this.#serving.call(request, message, session.settings);
    } catch (err) {
      stderrLine(`baton: serve() could not read the request; it is served as it came: ${printable(err)}`);
      return dispatched(dispatch, withoutUserGoal(message));
    }
    if (request.method !== TOOL_CALL) {
      const mark = request.method === TOOL_LIST ? new Mark(this, "listTools") : null;
      return this.#shaped(request, await dispatched(dispatch, message, mark), session);
    }
    if (call === null) return dispatched(dispatch, message);
    if (call.answer !== undefined) {
      this.#answerOurselves(call, session);
      return call.answer;
    }
    return this.#traced(call, dispatch, session);
  }

  #request(message: unknown): Request | null {
    if (this.#core.disabled) return null;
    try {
      return readRequest(message);
    } catch (err) {
      stderrLine(`baton: serve() could not read the request; it is served as it came: ${printable(err)}`);
      return null;
    }
  }

  /** Dispatch's `initialize` or `tools/list` answer with Baton's additions,
   * and its snapshot sent; the answer unchanged on failure. */
  #shaped(request: Request, answer: unknown, session: LibrarySession): unknown {
    try {
      if (request.method !== TOOL_LIST) return this.#serving.initialized(answer);
      const listed = this.#serving.listed(request, answer, session.settings);
      if (listed === null) return answer;
      if (listed.surface !== null) void this.#core.sendSurface(listed.surface, listed.seam, listed.serverOverlay);
      return listed.answer;
    } catch (err) {
      stderrLine(`baton: serve() could not add to the answer; it is served as it came: ${printable(err)}`);
      return answer;
    }
  }

  async #traced(call: Call, dispatch: (message: unknown) => unknown, session: LibrarySession): Promise<unknown> {
    let dispatching = false;
    try {
      return await runTrace(this.#core, session, traceOptions(call), async (trace) => {
        dispatching = true;
        const answer = await dispatched(dispatch, call.message, new Mark(this, "trace"));
        this.#record(trace, answer, session);
        return answer;
      });
    } catch (err) {
      if (dispatching) throw err;
      stderrLine(`baton: serve() could not trace the call: ${printable(err)}`);
      return dispatched(dispatch, call.message, new Mark(this, "trace"));
    }
  }

  #record(trace: Trace, answer: unknown, session: LibrarySession): void {
    const mode = this.#core.modeFor(session);
    const scrubber = this.#core.scrubber;
    const errorBody = (text: string): string => this.#core.errorBody(text);
    try {
      const error = jsonRpcError(answer);
      if (error !== null) {
        observeFailure(
          trace,
          JSONRPC_ERROR_TYPE,
          fieldsOrEmpty(() =>
            resultDerivedFields(mode, () => messageText(error.message), { ...error }, errorBody, scrubber),
          ),
        );
        return;
      }
      const result = resultOf(answer);
      if (isToolErrorResult(result)) {
        observeFailure(
          trace,
          TOOL_ERROR_TYPE,
          fieldsOrEmpty(() => returnedErrorFields(mode, result, errorBody, scrubber)),
        );
        return;
      }
      trace.observed(result ?? answer);
    } catch (err) {
      stderrLine(`baton: serve() could not record the tool call: ${printable(err)}`);
      try {
        trace.observed(undefined);
      } catch {
        // Nothing more to record.
      }
    }
  }

  #answerOurselves(call: Call, session: LibrarySession): void {
    try {
      if (call.report !== undefined) {
        void this.#core.annotate(session, this.#core.consentToken, call.report);
      } else if (call.kind === "hidden") {
        const scrubber = this.#core.scrubber;
        const fields = fieldsOrEmpty(() =>
          returnedErrorFields("full", call.answer!.result, (text) => this.#core.errorBody(text), scrubber),
        );
        runTrace(this.#core, session, traceOptions(call), (trace) =>
          observeFailure(trace, TOOL_ERROR_TYPE, fields, "tool_hidden"),
        );
      }
    } catch (err) {
      stderrLine(`baton: serve() could not record its own answer: ${printable(err)}`);
    }
  }

  /** An error, once per client and call, when the vendor's code inside
   * `serve()` still calls what `serve()` now does: the old wiring was left in. */
  #flagDoubleWiring(call: string): void {
    const mark = inDispatch.getStore();
    if (!mark?.active || mark.owner !== this || mark.flags !== call || this.#doubleWiringLogged.has(call)) return;
    this.#doubleWiringLogged.add(call);
    stderrLine(
      `baton: client.${call}() was called inside serve(). serve() already does this, so it is recorded ` +
        "twice. Remove the old Baton wiring: session(), trace(), listTools() and the report tool code.",
    );
  }

  /** Wait for events so far to reach the sink, then flush it. Never rejects;
   * returns within the sink's shutdown budget plus 250 ms (SPEC §11.2 rule 7). */
  async flush(): Promise<void> {
    await boundedSinkCall(this.#core.sink, "flush");
  }

  /** Flush, then close the sink. Later events are dropped. */
  aclose(): Promise<void> {
    this.#core.settings?.stop();
    this.#closing ??= boundedSinkCall(this.#core.sink, "aclose").then(() => {
      this.#core.closed = true;
    });
    return this.#closing;
  }
}
