/**
 * `withBaton` — the vendor's MCP integration entry point for the official
 * `@modelcontextprotocol/sdk`'s high-level `McpServer` — and the v2
 * packages' (`@modelcontextprotocol/server`), which are a different class of
 * the same name. `withBaton` takes the structural {@link SupportedMcpServer}
 * both satisfy and branches on the internals where the two majors differ:
 * where dispatch is intercepted (see {@link wrapIfNeeded}), how the intent
 * params are built (`schemaCompat.injectGoalParamsV2`), and where the call's
 * `_meta` lives (`mcpTypes.extraMeta`). Both are declared as OPTIONAL
 * peerDependencies and neither is imported — at runtime or as a type — so a
 * vendor installs whichever one they build on and nothing else.
 *
 * ```typescript
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // or "@modelcontextprotocol/server"
 * import { withBaton } from "@goodtiming/baton-sdk";
 *
 * const server = new McpServer({ name: "your-vendor-mcp", version: "1.0.0" });
 * const handle = withBaton(server, {
 *   vendorId: "your-vendor",
 *   vendorDisplayName: "Your Vendor",
 *   consentToken: "...",
 * });
 * ```
 *
 * Wraps every tool call to emit `tool_call_start` → call → `tool_call_end` /
 * `tool_call_error` — the latter on FAILURE, which MCP expresses two ways
 * (SPEC §11.4.3): the vendor handler throws, or it returns a result carrying
 * MCP's error flag on a 200. Reading only the first is what this package did,
 * and what §6.1's own wording told it to. Injects server `instructions`
 * (SPEC §5.1.2), registers
 * the `<vendor>_annotate` tool (SPEC §5.1.1), injects `user_goal`/
 * `expected_result`/`overall_task` intent params on every wrapped tool's
 * schema (SPEC §11.4.1 `call_intent`/`call_expected`/`call_workflow`/
 * `intent_source`), and captures a `surface_snapshot`
 * of the vendor-true surface. Every payload leaving here runs through the
 * configured scrubber, which defaults to the shipped ruleset (`src/scrub.ts`)
 * — see README "What is not here yet" for what's still not here (the low-level
 * `Server` adapter).
 *
 * Interception mechanism: `McpServer` has no middleware API (unlike the
 * standalone `fastmcp` library's `Middleware`/`CallNext`), so this patches
 * tool registration directly — the same shape Python's
 * `baton.integrations.mcp` adapter uses against the official `mcp` SDK, for
 * the same reason. Two passes, both required:
 *
 * 1. **Retroactive** — sweeps `server`'s already-registered tools (reaching
 *    into the private `_registeredTools` map, mirroring Python's
 *    `_registry.py` reaching into `_tool_manager._tools` — a documented,
 *    single swap point for an upstream rename PR, not an accident).
 * 2. **Prospective** — patches `registerTool` so every tool registered
 *    *after* `withBaton(server, ...)` runs is wrapped too.
 *
 * Together these make call ordering irrelevant — `withBaton` can run before
 * or after the vendor's own `registerTool` calls. Relying on only one pass
 * (as a naive `registerTool`-only patch would) silently drops capture for
 * tools registered on the other side of the ordering. The annotation tool
 * itself is excluded from this wrapping — it emits its own `annotation`
 * event instead of `tool_call_*`, same as the Python middleware's skip.
 *
 * Each wired entry's `.update()`/`.remove()` (mcp.js mutates the SAME
 * `RegisteredTool` object in place for both) are also patched: an
 * unpatched `.update()` replacing `paramsSchema`/`callback` would silently
 * wipe injected params and swap back to the vendor's raw, unwrapped
 * handler with no re-sweep able to detect it (the entry object identity
 * never changes); an unpatched `.remove()` would leave a phantom tool in
 * the surface snapshot forever.
 *
 * v2 makes the `.update()` patch carry more: there `remove()` IS
 * `update({name: null})` and `disable()`/`enable()` are `update({enabled})`,
 * all three routed through the entry's `update` *property* — so the patch
 * has to branch on which update it received rather than look only for
 * `paramsSchema`. It also supports renaming via `update({name})`, which 1.x
 * technically allowed and this module used to document as an unreconciled
 * gap; the surface snapshot, the param registry and the wrapper's own
 * `tool_name` now all follow a rename.
 *
 * Instructions injection reaches into `server.server`'s private
 * `_instructions` field — unlike Python's FastMCP (a read-only property
 * with a private-attribute fallback), the official TS SDK's `Server` has no
 * settable `instructions` at all post-construction, so there's no
 * "preferred" public path to fall back from here. `buildServerMeta` (the
 * `surface_snapshot` vendor-true baseline) MUST run before this assignment
 * — otherwise the snapshot would capture Baton's own instructions text
 * instead of the vendor's.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { uuid7 } from "../../uuid7.js";
import {
  AnnotationEventSchema,
  type Event,
  PromptGetEndEventSchema,
  PromptGetErrorEventSchema,
  PromptGetStartEventSchema,
  PromptListEndEventSchema,
  PromptListErrorEventSchema,
  PromptListStartEventSchema,
  ResourceListEndEventSchema,
  ResourceListErrorEventSchema,
  ResourceListStartEventSchema,
  ResourceReadEndEventSchema,
  ResourceReadErrorEventSchema,
  ResourceReadStartEventSchema,
  SurfaceSnapshotEventSchema,
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  ToolCallStartEventSchema,
} from "../../events.js";
import { StdoutSink, type Sink } from "../../sinks.js";
import { registerAnnotationTool } from "./annotation.js";
import { Scrubber } from "../../scrub.js";
import { scrubOrNull } from "./safeScrub.js";
import { roundMetaCoordinates } from "../../metaCoordinates.js";
import {
  resolveBatonConfig,
  resolveTenantId,
  withServerDisplayName,
  type BatonConfig,
  type ResolvedBatonConfig,
} from "./config.js";
import { captureDisabled, DisabledSink, logDisabled } from "../../optout.js";
import { capCodePoints } from "../../_text.js";
import { emit } from "./emit.js";
import {
  ERROR_BODY_MAX_CODE_POINTS,
  endResultFields,
  errorText,
  type FailureKind,
  OUTPUT_SCHEMA_MISMATCH,
  requestSideErrorFields,
  requestSideFailureKind,
  type ResultCaptureMode,
  type ToolEntryFacts,
  resultDerivedFields,
  returnedErrorFields,
  isErrorResult,
  TOOL_ERROR_TYPE,
} from "./errorResult.js";
import { BatonHandle } from "./handle.js";
import {
  deriveAnnotationToolName,
  resolveAnnotationToolName,
  usableServerName,
} from "./annotationName.js";
import { buildServerInstructions } from "./llmText.js";
import {
  EXPECTED_RESULT_PARAM_NAME,
  INTENT_SOURCE_PARAM,
  OVERALL_TASK_PARAM_NAME,
  USER_GOAL_PARAM_NAME,
} from "./llmText.js";
import { extraEnvelope, extraMeta, observeTransport, type Extra } from "./mcpTypes.js";
import { ProactiveTracker } from "./proactiveTracker.js";
import { detectAgentRuntime, UNKNOWN_AGENT_RUNTIME } from "./runtimeAdapter.js";
import { resolveSessionId } from "./sessionResolution.js";
import {
  type ResolvePrincipalHook,
  resolveCallPrincipal,
} from "./principalResolution.js";
import { SessionCounter } from "./sessionCounter.js";
import {
  advertiseUserGoalRequired,
  injectGoalParams,
  injectGoalParamsV2,
  toolInputJsonSchema,
  type IntentParamDispositions,
  type IntentParamMode,
} from "./schemaCompat.js";
import { assembleSurface, buildServerMeta, buildSeamAugmentations, surfaceHash } from "./surface.js";

type AnyArgs = unknown[];
type AnyHandler = (...args: AnyArgs) => unknown;
type TaggedHandler = AnyHandler & { [BATON_WRAPPED]?: boolean };

interface WrapContext {
  sink: Sink;
  counter: SessionCounter;
  tenantId: string;
  vendorId: string;
  consentToken: string;
  fallbackSessionId: string;
  /** The wrapped MCP server, kept for one read: the `initialize` handshake
   * it cached, which is where every client shipping today declares its name
   * and the only place either peer exposes it. Read lazily per call — the
   * handshake has not happened yet when `withBaton` runs. */
  server: SupportedMcpServer;
  scrubber: (value: unknown) => unknown;
  annotationToolName: string;
  intentParamMode: IntentParamMode;
  /** Whether result-derived data is withheld (SPEC §11.4). Validated once at
   * the config door, like `intentParamMode`, so nothing downstream re-checks
   * it. */
  resultCaptureMode: ResultCaptureMode;
  paramRegistry: Map<string, IntentParamDispositions>;
  /** Vendor-true JSON Schema for the surface snapshot, in whatever spelling
   * THIS server actually puts on the wire. */
  vendorToolJsonSchema: (name: string, inputSchema: unknown) => Record<string, unknown>;
  /** Drop v2's per-tool JSON-Schema memo after we mutate `inputSchema`. */
  bustSchemaMemo: (name: string) => void;
  /** The vendor's per-request identity resolver, or `undefined`. Resolved
   * ONCE at install and shared by the tool-call and annotation paths — two
   * resolutions could disagree, and an annotation naming a different actor
   * than the call it describes is worse than one naming nobody. */
  resolvePrincipal: ResolvePrincipalHook | undefined;
  tracker: ProactiveTracker;
  surfaceState: SurfaceState;
  emitSurface: (
    sessionId: string,
    digest: string,
    snapshot: Record<string, unknown>,
  ) => Promise<void>;
}

// `_registeredTools`, `RegisteredTool.handler`/`.executor`,
// `server.server._instructions`, `server.server._serverInfo` and
// `server.server._requestHandlers` (with the `setRequestHandler` that fills
// it, for the `tools/list` seam) are internal
// to the official SDK — 1.x and v2 alike — and not part of either public
// `.d.ts` surface. Reaching into them is deliberate (see module docstring),
// the same way Python's `_registry.py` does, and isolated to this one module
// so a future SDK internals change has exactly one place to update. Each
// reach-in is declared on a named local shape (`internals` in `install`,
// the small casts in `wrapIfNeeded`/`captureAndInject`) rather than an
// `any`, so a rename upstream lands as a compile error here.

const BATON_WRAPPED = Symbol("batonWrapped");
const wired = new WeakSet<object>();

/**
 * What the OUTER `tools/call` seam saw once the request handler was done with
 * it — the only thing the outer tells the inner.
 *
 * Both majors convert a thrown vendor handler into a returned `isError`
 * INSIDE their `tools/call` handler, so `raised` here is NOT the vendor's
 * raise: it is a failure the SDK threw out of the handler entirely, which on
 * v2 is how an unknown or disabled tool arrives
 * (`mcp-DXXb3Vv3.mjs:1394-1397`, both outside that handler's own `try`).
 */
type OuterOutcome = { failed: boolean } & (
  | {
      /** `tools/call` THREW. Its own member rather than `err !== undefined`,
       * because `throw undefined` is legal and must not read as a return. */
      raised: true;
      /** The value thrown out of `tools/call`. */
      err: unknown;
    }
  | {
      raised: false;
      /** What `tools/call` returned. On a failure this is the SDK's own error
       * envelope — `createToolError`'s on both majors — not the vendor's
       * value. */
      result: unknown;
    }
);

/** `tools/call` came back cleanly. A constant because it is the initial value
 * AND the outcome handed to a flush that is not the outer's to judge — two
 * sites, and a fifth member on `OuterOutcome` must not reach only one. */
const CLEAN_OUTCOME: OuterOutcome = { failed: false, raised: false, result: undefined };

/**
 * The per-call hand-off between Baton's two seams (SPEC §11.4.3's
 * `failure_kind`).
 *
 * ⚠ **`innerFired` is the discriminator for REQUEST-side vs result-side, and
 * it is the one the withholding rule needs too** — which is why the slot
 * carries no second field for it. `false` means the vendor's handler never ran, so the failure is
 * REQUEST-side and nothing on the payload is derived from a result (`"off"`
 * withholds nothing). `true` plus a failure at the outer means the handler
 * returned and something above it rejected what came back, so the failure is
 * RESULT-side and `"off"` withholds it. The hand-off and the provenance rule
 * are one mechanism; measured 2026-10-01 on both majors.
 *
 * ⚠ **It is not, however, the ONLY fact the settle reads, and an earlier
 * version of this paragraph said it was.** `settleCall` reads
 * `flushTerminal !== null` FIRST, so the real state space has three members —
 * inner unreached, inner reached but parked nothing (`openCall` threw), inner
 * reached and parked — and the third is subdivided by WHICH lane parked. That
 * last fact travels as the choice between `parkFailure` and `parkSuccess`
 * rather than as a field, which is what let the claim read as true.
 *
 * ⚠ **`flushTerminal` exists because two terminal events on one `call_id`
 * would break pairing** (SPEC §11.5.4 tier 1). The inner has already decided
 * which terminal event this call deserves by the time the outer learns the
 * call failed, so it PARKS that decision as a closure instead of emitting it,
 * and the outer flushes or replaces it. Parking a closure and not a built
 * event is deliberate: `counter.next` and `captured_at` must run at FLUSH, or
 * a replaced `tool_call_end` leaves an allocated sequence number behind and
 * the session's numbering gains a hole no consumer can explain.
 */
interface CallSlot {
  /** Set at the TOP of `batonWrap`, before anything that can throw.
   *
   * ⚠ The placement agrees with both majors by construction, not by luck:
   * each runs `validateToolInput` OUTSIDE the executor this wraps
   * (`mcp.js:125`, `mcp-DXXb3Vv3.mjs:1399`), so a rejected argument cannot
   * reach here and mark the flag. `test/integrations/mcp/aboveTool.test.ts`
   * pins that per major — a placement one line lower would still pass the
   * happy path and silently relabel every `invalid_argument`. */
  innerFired: boolean;
  /** The inner's parked terminal event, or `null` when the inner never got
   * far enough to decide on one (its own prelude threw — nothing to flush,
   * and NOT a request-side failure). */
  flushTerminal: ((outcome: OuterOutcome) => Promise<void>) | null;
}

/** Module-scoped rather than per-install, which is safe for one reason worth
 * naming: a slot is only ever read inside the dynamic extent of the dispatch
 * that created it, and `AsyncLocalStorage` nests — a tool whose handler calls
 * a second seamed server in-process enters that server's slot first, so the
 * inner wrapper there reads its own, not ours. Nothing is shared BETWEEN
 * calls, so there is no per-install state to keep. */
const callSlots = new AsyncLocalStorage<CallSlot>();

/** Tracks the vendor-true (pre-injection) tool surface for this install, for
 * `surface_snapshot` capture. Built from data already in hand at wrap time
 * and lazily hashed+emitted on the next tool call — mirrors the official
 * mcp SDK's Python adapter, which has the same "no tools/list hook"
 * constraint and makes the same lazy-on-first-call choice for the same
 * reason (see `project_sdk_sensor_parity_gap` memory). */
class SurfaceState {
  /** Every tool this install has seen, keyed by its CURRENT name. `disabled`
   * is tracked alongside rather than pruned, so re-enabling costs nothing and
   * — crucially — never needs a re-capture, which would re-read Baton's own
   * injected schema as if it were vendor-true. */
  private readonly rawTools = new Map<
    string,
    { disabled: boolean; tool: Record<string, unknown> }
  >();
  dirty = false;

  constructor(
    private readonly serverMeta: ReturnType<typeof buildServerMeta>,
    readonly emittedHashes: Set<string>,
  ) {}

  /** `inputSchemaJson` is already converted — by `ctx.vendorToolJsonSchema`,
   * which picks the spelling THIS SDK major puts on the wire. */
  noteTool(
    name: string,
    inputSchemaJson: Record<string, unknown>,
    description: string | undefined,
  ): void {
    this.rawTools.set(name, {
      disabled: this.rawTools.get(name)?.disabled ?? false,
      tool: { name, description: description ?? null, inputSchema: inputSchemaJson },
    });
    this.dirty = true;
  }

  pruneTool(name: string): void {
    if (this.rawTools.delete(name)) this.dirty = true;
  }

  /** Follow a `update({name})` rename, keeping the snapshot keyed the way
   * `tools/list` now renders it. */
  renameTool(from: string, to: string): void {
    const entry = this.rawTools.get(from);
    if (!entry) return;
    this.rawTools.delete(from);
    this.rawTools.set(to, { ...entry, tool: { ...entry.tool, name: to } });
    this.dirty = true;
  }

  /** Both majors filter `tools/list` on `tool.enabled`, so a disabled tool is
   * not part of the surface a client sees and must not be part of the one we
   * hash. Leaving it in is the same phantom-tool defect the `.remove()` patch
   * exists to prevent, reached through `disable()` instead. */
  setToolEnabled(name: string, enabled: boolean): void {
    const entry = this.rawTools.get(name);
    if (!entry || entry.disabled === !enabled) return;
    entry.disabled = !enabled;
    this.dirty = true;
  }

  buildSnapshot(): Record<string, unknown> {
    const names = [...this.rawTools.keys()].sort().filter((n) => !this.rawTools.get(n)!.disabled);
    return assembleSurface(
      this.serverMeta,
      names.map((n) => this.rawTools.get(n)!.tool),
    );
  }
}

/**
 * `error_body` for either failure shape (SPEC §11.4.3), so the two legs cannot
 * drift apart on the one rule they share.
 *
 * ⚠ **Scrub, THEN cut.** A PII value straddling the boundary must reach the
 * scrubber whole; cutting first hands it a fragment no pattern matches, and
 * the surviving half ships unredacted. ⚠ **Cut by CODE POINT** —
 * `capCodePoints` carries that reasoning, and Python's `[:2000]` counts code
 * points, so this is also what makes the two producers agree on what the cap
 * means in the one payload `emitterConformance.test.ts` compares
 * field-for-field.
 */
function errorBody(ctx: WrapContext, text: string): string {
  // eslint-disable-next-line no-restricted-syntax -- called only from emit() build thunks, so emit's guard already covers a throw here
  return capCodePoints(String(ctx.scrubber(text)), ERROR_BODY_MAX_CODE_POINTS);
}

/** `error_type` for a THROWN value (SPEC §11.4.3's RAISE shape): the
 * exception's class name, `"Error"` for anything that is not one. Shared by
 * the inner wrapper's raise lane and the outer seam, which both have to spell
 * it — two spellings would let the same thrown `ProtocolError` arrive under
 * two labels depending on which seam reported it. */
function errorTypeOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : "Error";
}

/** The human-readable text of a thrown value, by the same rule. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The envelope members every event shares, resolved off one MCP request —
 * everything except `principal`, which is deliberately not in here.
 *
 * Split out of `openCall` so the resource and prompt lifecycle seams (SPEC
 * §11.4.4) can build an envelope without the parts that are specific to a tool
 * call: there is no `principal` on those (see `installLifecycleSeam`), no
 * intent-param strip, and no `call_id`.
 *
 * Returns the PARTS rather than an assembled `common` so each caller spells its
 * own literal, which keeps `openCall` reading as one object and keeps
 * `principal` out of a shape that has no business resolving it.
 *
 * ⚠ **NOT for key order, which a first version of this paragraph claimed.**
 * Zod v4 emits output keys in SHAPE order, not input order, so
 * `envelopeShape` fixes the wire order however a caller spells its literal.
 * Recorded because the wrong reason is the kind a later reader preserves. */
async function resolveEnvelopeParts(
  ctx: WrapContext,
  extra: Extra,
): Promise<{ sessionId: string; runtime: string; scrubbedMeta: unknown }> {
  const meta = extraMeta(extra);
  const runtime =
    detectAgentRuntime(meta, {
      // v2 lifts the reserved `io.modelcontextprotocol/*` keys out of
      // `_meta`; 1.x leaves them in. Both are handed over — see
      // `mcpTypes.extraEnvelope`.
      envelope: extraEnvelope(extra),
      // Tier 2's carrier: neither peer puts client identity on the
      // handler context, both expose the cached handshake on the server.
      server: ctx.server,
      scrubber: ctx.scrubber,
    }) ?? UNKNOWN_AGENT_RUNTIME;
  // Coordinates are coarsened here: after the ladder above has read the
  // raw meta, and before the vendor's scrubber, so a vendor scrubber still
  // gets the rule (handoff D5). `_meta` only; params and results keep
  // full precision. The annotation tool does the same.
  const scrubbedMeta = scrubOrNull(ctx.scrubber, meta ? roundMetaCoordinates(meta) : null, "_meta");
  const sessionId = await resolveSessionId(ctx.fallbackSessionId, extra);
  return { sessionId, runtime, scrubbedMeta };
}

/**
 * Open a tool call: resolve everything the envelope needs, strip Baton's
 * injected intent params out of `params` IN PLACE, and emit the opening
 * events — the session's first proactive annotation, when there is one, then
 * `tool_call_start`.
 *
 * ⚠ **Extracted so BOTH seams open a call the same way.** The inner executor
 * wrapper opens a call that reached the vendor's handler; the outer
 * `tools/call` seam opens one the SDK rejected before the handler ran (SPEC
 * §11.4.3's three request-side `failure_kind`s), and those events must carry
 * the same identity, the same `principal`, the same stripped `params` and the
 * same `call_id` discipline. Two copies of this would be two chances for one
 * of them to drift — which is the miss-mechanism this thread has already paid
 * for twice.
 *
 * Returns what the TERMINAL event needs and nothing more: the envelope, the
 * minted `call_id`, and the session the counter is keyed on.
 */
async function openCall(
  ctx: WrapContext,
  toolName: string,
  extra: Extra,
  params: Record<string, unknown>,
  /** Is there a registry entry for this tool? `false` only from the
   * `tools/call` seam's `unknown_tool` path, and it suppresses one warning
   * whose diagnosis would be wrong there — see `extractGoalParam`. */
  registered = true,
): Promise<{ common: Record<string, unknown>; callId: string; sessionId: string }> {
  // ⚠ HERE, not in the callers. It was a caller obligation in both of them,
  // and this function exists precisely so the two cannot drift — a third
  // caller inheriting "remember the snapshot first" would silently stop
  // emitting it, which is the drift `openCall` was extracted to prevent. The
  // ordering invariant (snapshot BEFORE `tool_call_start`) is preserved and is
  // now structural.
  await maybeEmitSurfaceSnapshot(ctx);
  const { sessionId, runtime, scrubbedMeta } = await resolveEnvelopeParts(ctx, extra);

  // Strip the injected goal params IN PLACE, before snapshotting params —
  // `params` is the SAME object forwarded to the vendor handler, so the
  // strip keeps user_goal/expected_result off the tool AND out of the
  // captured `params` (which must equal the vendor-visible arguments).
  const dispositions = ctx.paramRegistry.get(toolName);
  const rawIntent = extractGoalParam(params, USER_GOAL_PARAM_NAME, toolName, dispositions, registered);
  const rawExpected = extractGoalParam(
    params,
    EXPECTED_RESULT_PARAM_NAME,
    toolName,
    dispositions,
    registered,
  );
  const rawWorkflow = extractGoalParam(params, OVERALL_TASK_PARAM_NAME, toolName, dispositions, registered);
  // Guarded because `params` is already stripped in place above.
  const scrubbedIntent = scrubOrNull(ctx.scrubber, rawIntent, USER_GOAL_PARAM_NAME);
  const scrubbedExpected = scrubOrNull(ctx.scrubber, rawExpected, EXPECTED_RESULT_PARAM_NAME);
  // Scrubbed like the other two. Deterministic redaction preserves the
  // exact-string continuity rung 3b groups on: the same label scrubs to
  // the same output on every call.
  const scrubbedWorkflow = scrubOrNull(ctx.scrubber, rawWorkflow, OVERALL_TASK_PARAM_NAME);

  // The per-call correlation key, minted HERE — in the one scope that emits
  // both legs — so start and end carry the same value by construction. It
  // is deliberately NOT part of `common`: `common` is also spread into the
  // proactive annotation below, and SPEC defines no `call_id` for an
  // annotation. Stamped onto the three tool-call events individually.
  const callId = uuid7();

  // Resolved AFTER the intent-param strip, so the hook's `arguments` are
  // exactly what the vendor's own handler receives — Baton's injected
  // params are never a caller's input and must not look like one.
  const principal = await resolveCallPrincipal(
    ctx.resolvePrincipal,
    { extra, toolName, arguments: params },
  );

  const common = {
    tenant_id: ctx.tenantId,
    vendor_id: ctx.vendorId,
    session_id: sessionId,
    consent_token: ctx.consentToken,
    agent_runtime: runtime,
    // The five `...common` sites below are the tool-call legs — start, end,
    // and BOTH failure shapes (SPEC §11.4.3) — plus the proactive
    // annotation, the same five Python stamps (`middleware.py`
    // 503/547/586/644/674; it was four until the returned shape landed
    // there too). `surface_snapshot` is deliberately NOT among them: it
    // describes the SERVER and is captured outside any call, so there is no
    // caller to name (register D5).
    principal,
    // Same five stamps, same exclusion: a surface_snapshot describes the
    // SERVER and is captured outside any call, so it has no caller's
    // transport to name any more than it has a caller to name.
    transport_observed: observeTransport(extra),
    runtime_meta: scrubbedMeta,
  };

  // The session's FIRST injected intent also becomes a proactive
  // annotation (carrying expected_result too, if present), sequenced
  // BEFORE the tool_call_start it explains. `claim` dedups per session
  // and is suppressed when a real annotation-tool proactive already
  // fired. Later param intents ride only the start event.
  if (scrubbedIntent !== null && ctx.tracker.claim(sessionId)) {
    await emit(ctx.sink, () =>
      AnnotationEventSchema.parse({
        ...common,
        sequence_number: ctx.counter.next(sessionId),
        captured_at: new Date().toISOString(),
        payload: {
          intent: scrubbedIntent,
          expected_outcome: scrubbedExpected,
          intent_source: INTENT_SOURCE_PARAM,
          tool_name: toolName,
        },
      }),
    );
  }

  await emit(ctx.sink, () =>
    ToolCallStartEventSchema.parse({
      ...common,
      call_id: callId,
      sequence_number: ctx.counter.next(sessionId),
      captured_at: new Date().toISOString(),
      payload: {
        tool_name: toolName,
        // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw drops the event, which is correct for params
        params: ctx.scrubber(params),
        call_intent: scrubbedIntent,
        call_expected: scrubbedExpected,
        call_workflow: scrubbedWorkflow,
        intent_source: scrubbedIntent !== null ? INTENT_SOURCE_PARAM : null,
      },
    }),
  );
  return { common, callId, sessionId };
}

/** `nameRef` is read on every call, not captured: v2's `update({name})`
 * renames a tool in place, keeping the same entry object AND the same
 * executor, so a wrapper that closed over the registration-time string would
 * keep emitting events under the old `tool_name` and keep missing its own
 * param-registry entry — which downgrades the strip to the cold-registry
 * path and puts a warning on the vendor's stderr for every call. */
function batonWrap(nameRef: { current: string }, original: AnyHandler, ctx: WrapContext): AnyHandler {
  return async (...callArgs: AnyArgs): Promise<unknown> => {
    const toolName = nameRef.current;
    // ⚠ FIRST, ahead of every await below. The flag's whole job is to say the
    // vendor's handler was REACHED, and a line of this prelude that threw
    // after a later assignment would leave the outer seam reporting a
    // request-side failure about a call that got this far. See `CallSlot`.
    const slot = callSlots.getStore();
    if (slot) slot.innerFired = true;

    const extra = callArgs[callArgs.length - 1] as Extra;
    // 1.x calls a schema-less tool as `(extra)`; v2 always calls its
    // executor `(args, ctx)` and passes `args === undefined` for one. Both
    // land on `{}` here — and the ORIGINAL `callArgs` is what gets
    // delegated, so the arity fork stays inside the callee either way.
    const params = ((callArgs.length > 1 ? callArgs[0] : undefined) ?? {}) as Record<
      string,
      unknown
    >;
    // ⚠ `params` is the SAME object forwarded to the vendor's handler, and
    // `openCall` strips Baton's injected intent params out of it IN PLACE —
    // which is what keeps `user_goal`/`expected_result` off the tool AND out
    // of the captured `params`, since those must equal the vendor-visible
    // arguments. The outer seam's request-side path passes a COPY instead,
    // for the reason stated there.
    const { common, callId, sessionId } = await openCall(ctx, toolName, extra, params);

    /** Emit this call's terminal event, or PARK it for the outer `tools/call`
     * seam when one is running (see `CallSlot`). `replacement` is passed by
     * the SUCCESS lane alone: it is the only terminal event the outer may
     * overwrite, because a parked FAILURE is already the vendor's own code
     * speaking — it raised, or it returned the flag — and SPEC §11.4.3's two
     * shapes own it. Relabelling that as `output_schema_mismatch` would blame
     * our conversion for the vendor's failure. */
    const terminate = async (
      build: () => Event,
      replacement: ((outcome: OuterOutcome) => Event) | null,
    ): Promise<void> => {
      if (!slot) {
        // No outer seam: a direct executor call, or a server whose internals
        // this package could not reach. Emit exactly as it always has — and
        // SPEC §11.4.3 agrees that is the right degradation, since "a
        // producer with only one seam cannot emit `failure_kind` correctly
        // and MUST omit it".
        await emit(ctx.sink, build);
        return;
      }
      // ⚠ **A parked terminal already here belongs to an EARLIER-completING
      // call in this same dispatch, and flushing it now is what keeps it from
      // being dropped.** The slot holds one decision, and parking without
      // this would overwrite it: a `tool_call_start` with no terminal, which
      // SPEC §11.5.4 leaves permanently unpaired. Two shapes reach it, one
      // probed and one read:
      //
      //   - a vendor handler that invokes a SIBLING tool's wrapped executor
      //     in-process — the inner call completes first, so the outer's park
      //     lands second and used to erase it;
      //   - v2's legacy `inputRequired` shim, which loops
      //     `await handler(request, ctxNext)` inside ONE dispatch
      //     (`mcp-DXXb3Vv3.mjs:602`), so every round but the last parks and
      //     is immediately superseded.
      //
      // The earlier one is flushed UNREPLACED, which is the correct reading
      // rather than a convenience: the outer's outcome describes the call
      // `tools/call` itself dispatched, and that call is always the LAST to
      // decide, because its own `await` encloses everything it called.
      // Relabelling an inner call's success `output_schema_mismatch` would
      // blame whichever round happened to finish first.
      const earlier = slot.flushTerminal;
      if (earlier !== null) await earlier(CLEAN_OUTCOME);
      slot.flushTerminal = async (outcome) => {
        // The choice is made INSIDE the thunk, so either branch allocates its
        // sequence number at flush — the property `CallSlot` exists to keep.
        await emit(ctx.sink, () =>
          replacement !== null && outcome.failed ? replacement(outcome) : build(),
        );
      };
    };

    /** Park a terminal event the outer seam may NOT overwrite — the vendor's
     * own code spoke, by raising or by returning the flag, and SPEC §11.4.3's
     * two shapes own it. */
    const parkFailure = (build: () => Event): Promise<void> => terminate(build, null);

    /** Park the SUCCESS terminal, with what to emit instead if the outer seam
     * saw the call fail anyway.
     *
     * ⚠ Two functions rather than one optional parameter, so "only the success
     * lane is replaceable" is a thing the type system enforces instead of a
     * paragraph a future caller can skip. The invariant used to live only in
     * `terminate`'s docstring, where adding a replacement to the `isError`
     * lane would have compiled, passed every test, and relabelled the
     * vendor's own exception as our conversion's. */
    const parkSuccess = (
      build: () => Event,
      replacement: (outcome: OuterOutcome) => Event,
    ): Promise<void> => terminate(build, replacement);

    const startedAt = performance.now();
    let result: unknown;
    try {
      result = await original(...callArgs);
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      await parkFailure(() =>
        ToolCallErrorEventSchema.parse({
          ...common,
          call_id: callId,
          sequence_number: ctx.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          payload: {
            tool_name: toolName,
            error_type: errorTypeOf(err),
            // ⚠ KEPT under `resultCaptureMode: "off"`, and that is the rule's
            // shape rather than an exception to it: the rule is keyed on
            // PROVENANCE, and a thrown error's message is the vendor's own
            // code speaking about a call that returned nothing (SPEC
            // §11.4.3(1)). A switch written as "drop `error_body`" would
            // delete the highest-value diagnostic the product has.
            error_body: errorBody(ctx, messageOf(err)),
            duration_ms: durationMs,
            // Explicit, though the field is `.optional()` and this is its
            // absent value. The schema is deliberately not an emitter (see
            // `ToolCallErrorPayloadSchema`), so if this leg stayed silent the
            // key would be missing. Each of the two failure shapes declares
            // which it is, the same reason Python's emitter made the parameter
            // positional-without-default.
            //
            // ⚠ Guarded by `errorResult.test.ts`'s `toContain("result")`, NOT by
            // the cross-SDK key-set check — measured by removing this line. Why,
            // at one site: `endResultFields` in `errorResult.ts`. SPEC §11.4.3
            // states the same void rationale and wants the same amendment.
            result: null,
          },
        }),
      );
      throw err;
    }

    const durationMs = Math.round(performance.now() - startedAt);

    // The OTHER failure shape (SPEC §11.4.3): the handler returned normally
    // and the result carries MCP's error flag, which rides a 200 rather than a
    // JSON-RPC error. It arrives here rather than through the catch above, and
    // filing it as `tool_call_end` is filing a failure as a success.
    if (isErrorResult(result)) {
      await parkFailure(() =>
        ToolCallErrorEventSchema.parse({
          ...common,
          call_id: callId,
          sequence_number: ctx.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          payload: {
            tool_name: toolName,
            error_type: TOOL_ERROR_TYPE,
            duration_ms: durationMs,
            // Both remaining members are unwrapped FROM the result on this
            // shape, so one projection decides them together and owns the
            // scrubber call. `error_type` is NOT result-derived and is passed
            // regardless: the call still failed (SPEC §11.2.6).
            //
            // ⚠ Under `"full"` `result` is the whole envelope, and on this
            // producer that is the same shape `tool_call_end.result` records —
            // which is NOT what Python's contrast says.
            // `ToolCallErrorPayloadSchema` in `events.ts` holds that claim and
            // names the test that enforces it.
            ...returnedErrorFields(
              ctx.resultCaptureMode,
              result,
              (text) => errorBody(ctx, text),
              ctx.scrubber,
            ),
          },
        }),
      );
      // Returned, never thrown. The vendor chose to report this failure as a
      // value, and §11.2 says a sensor does not change what the caller sees.
      return result;
    }

    await parkSuccess(
      () =>
        ToolCallEndEventSchema.parse({
          ...common,
          call_id: callId,
          sequence_number: ctx.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          payload: {
            tool_name: toolName,
            duration_ms: durationMs,
            ...endResultFields(ctx.resultCaptureMode, result, ctx.scrubber),
          },
        }),
      // The handler returned something this sensor reads as a success, and
      // then the outer seam saw the call fail anyway — so what failed is the
      // producer's own conversion of the output (SPEC §11.4.3's
      // `output_schema_mismatch`). Correcting this is the whole point of the
      // second seam: without it this is a `tool_call_end` for a call the
      // CALLER saw fail, which is a success the product invented.
      (outcome) =>
        ToolCallErrorEventSchema.parse({
          ...common,
          call_id: callId,
          sequence_number: ctx.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          payload: {
            tool_name: toolName,
            // The lane the OUTER came back on, not this one's: on 2.x the
            // conversion failure is converted to a returned `isError` inside
            // `tools/call` (`mcp-DXXb3Vv3.mjs:1402`), so `"tool_error"` is
            // right there. A throw out of the handler is unreachable on
            // either major today for this lane; spelled anyway, because the
            // alternative is a crash on the day it stops being.
            error_type: outcome.raised ? errorTypeOf(outcome.err) : TOOL_ERROR_TYPE,
            // ⚠ The INNER's measurement — the vendor's handler duration —
            // not the outer's. Every other leg means the same thing by this
            // member, and widening it here for one failure kind would make
            // `duration_ms` mean two things in one column.
            duration_ms: durationMs,
            failure_kind: OUTPUT_SCHEMA_MISMATCH,
            // ⚠ **WITHHELD under `"off"`, unlike the three request-side
            // kinds.** The message quotes the value the tool returned
            // ("`'not-an-int'` is not of type `integer`"), so it is
            // result-derived by provenance and goes — which leaves
            // `failure_kind` as the ONLY surviving signal for this failure
            // under `"off"`, and is the measurement that justified putting
            // the member on the wire at all.
            //
            // ⚠ `result` is what the CLIENT received — the SDK's own error
            // envelope — not the vendor's rejected return value. §11.4.3
            // asks for the envelope that holds the flag and the reason, and
            // this package's own invariant is that it agrees with the
            // caller. Recording the rejected output TOO would need a member
            // nothing on the wire has; the loss is deliberate and worth
            // knowing when debugging one of these.
            ...resultDerivedFields(
              ctx.resultCaptureMode,
              () => (outcome.raised ? messageOf(outcome.err) : errorText(outcome.result)),
              // ⚠ `null` on the `raised` lane, never `undefined`, and the
              // union is what forces the branch rather than a comment: the
              // scrubber would answer `undefined` and DROP the key, where the
              // sibling raise lane a few lines up declares `result: null`
              // explicitly, for the reason `ToolCallErrorPayloadSchema`
              // records. One shape for "no result object existed", not two.
              outcome.raised ? null : outcome.result ?? null,
              (text) => errorBody(ctx, text),
              ctx.scrubber,
            ),
          },
        }),
    );

    return result;
  };
}

/** Pop an injected goal param from `args` in place; return its value.
 * `"native"` (the tool already declares this name itself) forwards the
 * caller's own value untouched — never stripped, never reported as intent.
 * Unlisted (a call arrived before this tool was ever wired, or
 * `intentParamMode` was "off" when it was) strips defensively with a
 * warning: safe only because these two names are reserved. */
function extractGoalParam(
  args: Record<string, unknown>,
  paramName: string,
  toolName: string,
  dispositions: IntentParamDispositions | undefined,
  registered: boolean,
): string | null {
  if (!(paramName in args)) return null;
  const disposition = dispositions ? dispositions[paramName] : undefined;
  if (disposition === "native") return null;
  // ⚠ The warning says "cold registry", which is a real and useful diagnosis
  // for a tool that EXISTS and was never wired — and a wrong one for a tool
  // that does not exist at all. The `tools/call` seam reaches here for an
  // unknown tool, where there is no entry to have been wired, so the caller
  // says which case it is rather than letting this infer it from an absent
  // disposition that means two different things.
  if (disposition === undefined && registered) {
    process.stderr.write(
      `baton: stripping ${paramName} from unlisted tool ${JSON.stringify(toolName)} (cold registry)\n`,
    );
  }
  const raw = args[paramName];
  delete args[paramName];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/** A server whose surface differs on every request would otherwise grow the
 * shared set for the life of the process. */
const MAX_REMEMBERED_SURFACES = 1024;

/** Lazy, fail-open surface_snapshot capture — the first tool call after any
 * registration change re-hashes the surface and emits iff the hash hasn't
 * been seen before. `dirty` is cleared FIRST so a hashing/serialization
 * error (deterministic — would just re-throw identically every call) costs
 * one attempt per surface change, not a retry storm. A WRITE failure is
 * different (sink health can recover), so that path re-sets `dirty = true`
 * to retry on the next call, and takes the digest back out of
 * `emittedHashes`, so a transient failure can't permanently drop a
 * surface the way a genuine dedup skip would. */
async function maybeEmitSurfaceSnapshot(ctx: WrapContext): Promise<void> {
  if (!ctx.surfaceState.dirty) return;
  ctx.surfaceState.dirty = false;
  let snapshot: Record<string, unknown>;
  let digest: string;
  try {
    snapshot = ctx.surfaceState.buildSnapshot();
    digest = surfaceHash(snapshot);
  } catch (err) {
    process.stderr.write(`baton: surface snapshot capture failed: ${String(err)}\n`);
    return;
  }
  const emitted = ctx.surfaceState.emittedHashes;
  if (emitted.has(digest)) return;
  if (emitted.size >= MAX_REMEMBERED_SURFACES) emitted.clear();
  // Reserved before the write, so two servers sharing this set cannot both
  // send it: `createBaton.test.ts`, "when the first requests arrive together".
  emitted.add(digest);
  const seam = buildSeamAugmentations({
    injectedToolNames: [ctx.annotationToolName],
    intentParamNames: [USER_GOAL_PARAM_NAME, EXPECTED_RESULT_PARAM_NAME, OVERALL_TASK_PARAM_NAME],
    intentParamMode: ctx.intentParamMode,
  });
  try {
    await ctx.emitSurface(ctx.fallbackSessionId, digest, { ...snapshot, seam_augmentations: seam });
  } catch (err) {
    process.stderr.write(`baton: surface snapshot capture failed: ${String(err)}\n`);
    emitted.delete(digest);
    ctx.surfaceState.dirty = true;
  }
}

/** Capture the entry's CURRENT `inputSchema` as vendor-true and splice in
 * the goal params. Only safe to call when `inputSchema` is known-fresh
 * (vendor-true, not already carrying a prior injection) — i.e. at first
 * processing, or right after a `.update()` call that itself supplied a new
 * `paramsSchema` (mcp.js replaces `inputSchema` wholesale in that case, so
 * whatever was captured/injected before is gone regardless of what this
 * function does). Calling it on an entry whose schema is STILL Baton's own
 * previously-injected version would misread `user_goal`/`expected_result`
 * as the vendor's own fields (`"native"` disposition) and silently stop
 * stripping/capturing them — callers must gate on that, not call this
 * unconditionally on every `.update()`. */
function captureAndInject(name: string, entry: unknown, ctx: WrapContext): void {
  if (!entry || typeof entry !== "object") return;
  const mutable = entry as { inputSchema?: unknown; description?: string; executor?: unknown };
  ctx.surfaceState.noteTool(name, ctx.vendorToolJsonSchema(name, mutable.inputSchema), mutable.description);
  if (ctx.intentParamMode === "off") return;
  const isV2 = typeof mutable.executor === "function";
  try {
    const { schema, dispositions } = isV2
      ? injectGoalParamsV2(mutable.inputSchema, ctx.intentParamMode)
      : injectGoalParams(mutable.inputSchema, ctx.intentParamMode);
    if (Object.keys(dispositions).length > 0) {
      // Assigned directly rather than via `entry.update({paramsSchema})`,
      // which would route back through our OWN patched update and re-read
      // Baton's just-injected schema as if it were vendor-true — flipping
      // every injected param's disposition to "native" and silently
      // stopping the strip. The memo bust below is what `update` would have
      // done for us.
      mutable.inputSchema = schema;
      ctx.bustSchemaMemo(name);
      ctx.paramRegistry.set(name, dispositions);
    } else {
      ctx.paramRegistry.delete(name);
    }
  } catch {
    // Fail open — a schema this module can't handle just skips injection
    // for this tool; capture/wrap of the tool itself is unaffected.
  }
}

/** The two request-handler internals the request seams reach, shared by both
 * majors' `Protocol`: the per-method dispatch map, and the setter that fills
 * it. Typed `unknown` and checked at install, so a server laid out
 * differently gets no seam rather than a crash. */
interface RequestHandlerInternals {
  _requestHandlers?: unknown;
  setRequestHandler?: unknown;
}

const TOOLS_LIST_METHOD = "tools/list";
const TOOLS_LIST_SEAM = Symbol("batonToolsListSeam");
const TOOLS_CALL_METHOD = "tools/call";
const TOOLS_CALL_SEAM = Symbol("batonToolsCallSeam");
type SeamedHandler = AnyHandler & { [tag: symbol]: boolean | undefined };

/**
 * Install a seam around ONE JSON-RPC method's request handler.
 *
 * Both majors dispatch requests through `server.server._requestHandlers`, a
 * `Map` keyed by method and read per request (1.x `shared/protocol.js`
 * `_onrequest`; v2 `Protocol._onrequest`), and both `McpServer`s install
 * their tool handlers lazily, on the first `registerTool` (v2 also eagerly,
 * when constructed with a `tools` capability). So both orders are covered: a
 * handler already in the map is wrapped now, and `setRequestHandler` is
 * patched so one set later is wrapped as it lands. Keyed on the map entry
 * rather than on the setter's arguments, because the majors spell the method
 * differently (a zod schema on 1.x, a string on v2) and both land in the same
 * map.
 *
 * ⚠ **Shared by both seams, which is what makes installing two of them
 * safe.** Each one patches `setRequestHandler`, so the second install must
 * reach the first's patch rather than the pristine setter — which it does,
 * because `originalSet` is read at install time, after the earlier patch has
 * landed. That composition held when this was one hand-written function per
 * seam too; one helper makes it structural rather than a property of the call
 * order in `install`.
 *
 * ⚠ A server whose internals do not have this shape gets no seam at all.
 * What that costs differs per seam and is stated at each call site.
 */
function installRequestSeam(
  lowLevel: RequestHandlerInternals,
  method: string,
  seamTag: symbol,
  wrap: (handler: AnyHandler) => AnyHandler,
): void {
  const table = lowLevel._requestHandlers;
  const originalSet = lowLevel.setRequestHandler;
  if (!(table instanceof Map) || typeof originalSet !== "function") return;
  const handlers = table as Map<string, unknown>;
  const setRequestHandler = originalSet as AnyHandler;

  const wrapCurrent = (): void => {
    const handler = handlers.get(method) as SeamedHandler | undefined;
    if (typeof handler !== "function" || handler[seamTag]) return;
    const seamed = wrap(handler) as SeamedHandler;
    seamed[seamTag] = true;
    handlers.set(method, seamed);
  };

  wrapCurrent();
  lowLevel.setRequestHandler = (...args: AnyArgs): unknown => {
    const registered = setRequestHandler.apply(lowLevel, args);
    wrapCurrent();
    return registered;
  };
}

/**
 * The `tools/list` RESPONSE seam, which is what lets `intentParamMode:
 * "required"` advertise `user_goal` as required without the validator
 * enforcing it (see `schemaCompat.buildIntentFields` for why zod cannot).
 *
 * ⚠ Fail-open, twice. A throw from the transform is logged and the SDK's own
 * result goes out untouched, because a vendor's `tools/list` may never break
 * on Baton's account. And a server with no reachable handler map gets no seam,
 * which costs the advertisement and nothing else.
 */
function installToolsListSeam(lowLevel: RequestHandlerInternals, ctx: WrapContext): void {
  const isInjected = (toolName: string): boolean =>
    ctx.paramRegistry.get(toolName)?.[USER_GOAL_PARAM_NAME] === "injected";
  const advertise = (result: unknown): unknown => {
    try {
      return advertiseUserGoalRequired(result, isInjected);
    } catch (err) {
      process.stderr.write(
        `baton: tools/list advertisement failed; serving the SDK's own result: ${String(err)}\n`,
      );
      return result;
    }
  };

  installRequestSeam(lowLevel, TOOLS_LIST_METHOD, TOOLS_LIST_SEAM, (handler) => (...args) => {
    const out = handler(...args);
    return isThenable(out) ? out.then(advertise) : advertise(out);
  });
}

const LIFECYCLE_SEAMS = {
  resourceList: Symbol("batonResourceListSeam"),
  resourceRead: Symbol("batonResourceReadSeam"),
  promptList: Symbol("batonPromptListSeam"),
  promptGet: Symbol("batonPromptGetSeam"),
} as const;

/** The three event schemas one lifecycle family needs, structurally rather
 * than by Zod generics: all twelve `.parse` to something assignable to
 * `Event`, and that is the only thing the seam does with them. */
interface LifecycleSchemas {
  start: { parse(value: unknown): Event };
  end: { parse(value: unknown): Event };
  error: { parse(value: unknown): Event };
}

/**
 * The RESOURCE and PROMPT lifecycle seams (SPEC §11.4.4) — `baton-ts`'s first
 * instrumentation of anything but a tool call.
 *
 * ⚠ **At the REQUEST handler, not at registration**, and that is the whole
 * design rather than a convenience. The vantage point the twelve shapes were
 * defined from is `baton-proxy`'s, which reads the wire: subject, timing,
 * failure, no body. The request handler is the in-process position that sees
 * the same four facts — and it needs no per-family registration patch, since
 * both majors install all four handlers through the one `_requestHandlers` map
 * `installRequestSeam` already handles, lazily and in either order.
 *
 * ⚠ **No `principal` on any of the twelve, and it is a decision.** The vendor's
 * `resolvePrincipal` hook is TOOL-shaped — it takes `{extra, toolName,
 * arguments}` — so calling it with a URI in `toolName` would stretch a contract
 * a vendor's hook cannot anticipate. The proxy stamps no principal on these
 * types either (its twelve enqueue methods take none), so omitting it is parity
 * with the producer the shapes came from rather than a gap this package
 * invented. A later release that wants identity here needs a hook shape first.
 *
 * ⚠ **No `call_id` either**, same reason: no producer mints one for these, so
 * a consumer pairing a start with its end has only SPEC §11.5.4's FIFO floor.
 * §11.4.4 records that rather than leaving it to be discovered.
 *
 * ⚠ **Fail-open throughout (SPEC §11.2).** Every event goes through `emit`,
 * the whole settle is wrapped, and the vendor's result and the vendor's
 * exception pass through untouched in both lanes. A server with no reachable
 * handler map gets no seam, which costs these twelve events and nothing else.
 *
 * ⚠ **The error leg is THROW-ONLY, which is why there is no returned-flag
 * branch here.** `isError` is a `CallToolResult` member; a failing resource
 * read or prompt get comes back as a JSON-RPC error, so `error_type` is the
 * exception's class name — §11.4.3's RAISE spelling. `baton-proxy` files the
 * JSON-RPC numeric code instead, because the wire is what it holds. §11.4.4
 * states the divergence; both conform, and the member is an open string.
 */
/** One lifecycle family's three event schemas plus the two facts that differ
 * between families. A DATA table, so adding `resources/templates/list` or
 * `completion/complete` is a row rather than a copied block.
 *
 * ⚠ `startParams` stays a CALLBACK while the other two are keys, and the
 * asymmetry is the point: the three `*_start` shapes are genuinely different
 * (none / the whole bag minus `_meta` / the `arguments` member alone) and that
 * difference is the proxy's own inconsistency, which §11.4.4 records. Encoding
 * it as a mode string would only relocate the switch. */
interface LifecycleSpec {
  method: string;
  seamTag: symbol;
  schemas: LifecycleSchemas;
  /** The dedicated subject member's key — `"uri"` for a read, `"name"` for a
   * prompt get, absent for either list, which has no subject. It rides all
   * three legs, so one key decides it for the family. */
  subjectKey?: "uri" | "name";
  /** Which array of the `*_list` result `count` counts. Absent for the two
   * families that have no count. */
  countKey?: "resources" | "prompts";
  /** The `*_start` payload's `params` member, or `{}` where the family has
   * none. */
  startParams: (params: Record<string, unknown>) => Record<string, unknown>;
}

function installLifecycleSeam(
  lowLevel: RequestHandlerInternals,
  ctx: WrapContext,
  spec: LifecycleSpec,
): void {
  installRequestSeam(lowLevel, spec.method, spec.seamTag, (handler) => async (...args) => {
    const request = args[0] as { params?: Record<string, unknown> } | undefined;
    const requestParams = request?.params ?? {};
    const extra = args[1] as Extra;

    // ⚠ ONE `const`, not three `let`s with placeholder values. `emit`'s build
    // thunks capture this, and TypeScript will not narrow a captured MUTABLE
    // binding — which is what the three `const envelope = common` aliases an
    // earlier version carried were working around. `null` means the start
    // capture failed, and there is then nothing to stamp the later legs with.
    const opened = await openLifecycleCall(ctx, spec, requestParams, extra);

    /** Every leg is the same envelope with a different schema and payload, so
     * one builder owns the parts that must not drift: the stamp, the clock and
     * the sequence number — which `counter.next` must allocate at EMIT time,
     * not before. */
    const fire = async (
      schema: { parse(value: unknown): Event },
      payload: Record<string, unknown>,
    ): Promise<void> => {
      if (opened === null) return;
      await emit(ctx.sink, () =>
        schema.parse({
          ...opened.common,
          sequence_number: ctx.counter.next(opened.sessionId),
          captured_at: new Date().toISOString(),
          payload: scrubLifecyclePayload(ctx, { ...opened.subject, ...payload }),
        }),
      );
    };

    await fire(spec.schemas.start, spec.startParams(requestParams));

    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    try {
      const result = await handler(...args);
      await fire(spec.schemas.end, {
        ...(spec.countKey === undefined ? {} : { count: countOf(result, spec.countKey) }),
        duration_ms: elapsed(),
      });
      return result;
    } catch (err) {
      await fire(spec.schemas.error, {
        error_type: errorTypeOf(err),
        // KEPT under every capture mode: a failed FETCH's message is the
        // producer's own diagnostic, not anything a resource returned, so
        // nothing here is result-derived (SPEC §11.4.4). The scrub and the cap
        // are `scrubLifecyclePayload`'s, in that order.
        error_body: messageOf(err),
        duration_ms: elapsed(),
      });
      // Rethrown unchanged — a sensor does not change what the caller sees.
      throw err;
    }
  });
}

/** Resolve the envelope and the subject for one lifecycle request, or `null`
 * when that failed.
 *
 * Separate from the seam so the three legs share ONE immutable result. Guarded
 * here rather than at each leg because the vendor's request has not run yet:
 * losing the capture costs the pairing, never the call (SPEC §11.2). */
async function openLifecycleCall(
  ctx: WrapContext,
  spec: LifecycleSpec,
  requestParams: Record<string, unknown>,
  extra: Extra,
): Promise<{
  common: Record<string, unknown>;
  sessionId: string;
  subject: Record<string, unknown>;
} | null> {
  try {
    const parts = await resolveEnvelopeParts(ctx, extra);
    return {
      sessionId: parts.sessionId,
      subject:
        spec.subjectKey === undefined
          ? {}
          : { [spec.subjectKey]: stringSubject(requestParams[spec.subjectKey]) },
      common: {
        tenant_id: ctx.tenantId,
        vendor_id: ctx.vendorId,
        session_id: parts.sessionId,
        consent_token: ctx.consentToken,
        agent_runtime: parts.runtime,
        transport_observed: observeTransport(extra),
        runtime_meta: parts.scrubbedMeta,
      },
    };
  } catch (err) {
    process.stderr.write(`baton: ${spec.method} capture failed: ${String(err)}\n`);
    return null;
  }
}

/** Every lifecycle family, as one table.
 *
 * ⚠ The two `startParams` builders that DO something are deliberately
 * different, and §11.4.4 records why: `baton-proxy` built them differently and
 * these shapes are transcribed from it, not designed. */
const NO_PARAMS = (): Record<string, unknown> => EMPTY_PARAMS;

/** Shared because it is only ever SPREAD, never mutated. The thunk used to
 * allocate a throwaway object on every `resources/list` and `prompts/list`
 * request to produce nothing. */
const EMPTY_PARAMS: Record<string, unknown> = Object.freeze({});

const LIFECYCLE_SPECS: readonly LifecycleSpec[] = [
  {
    method: "resources/list",
    seamTag: LIFECYCLE_SEAMS.resourceList,
    schemas: {
      start: ResourceListStartEventSchema,
      end: ResourceListEndEventSchema,
      error: ResourceListErrorEventSchema,
    },
    // ⚠ `resources` ALONE. Resource TEMPLATES are a separate MCP method with
    // their own result array and are deliberately not added in, matching the
    // proxy — so a template-only server reports 0, which §11.4.4 says a
    // consumer MUST NOT read as "this server has no resources".
    countKey: "resources",
    startParams: NO_PARAMS,
  },
  {
    method: "resources/read",
    seamTag: LIFECYCLE_SEAMS.resourceRead,
    schemas: {
      start: ResourceReadStartEventSchema,
      end: ResourceReadEndEventSchema,
      error: ResourceReadErrorEventSchema,
    },
    subjectKey: "uri",
    // ⚠ The whole params bag MINUS `_meta`, so `uri` lands here as well as in
    // its own member. That duplication is the proxy's and is reproduced on
    // purpose: the dedicated member is what a consumer reads, the bag is what
    // the caller actually sent, and a producer that stripped `uri` out could no
    // longer say the second thing. `_meta` is excluded because it rides the
    // envelope as `runtime_meta` already.
    startParams: (params) => ({ params: paramsBag(params) }),
  },
  {
    method: "prompts/list",
    seamTag: LIFECYCLE_SEAMS.promptList,
    schemas: {
      start: PromptListStartEventSchema,
      end: PromptListEndEventSchema,
      error: PromptListErrorEventSchema,
    },
    countKey: "prompts",
    startParams: NO_PARAMS,
  },
  {
    method: "prompts/get",
    seamTag: LIFECYCLE_SEAMS.promptGet,
    schemas: {
      start: PromptGetStartEventSchema,
      end: PromptGetEndEventSchema,
      error: PromptGetErrorEventSchema,
    },
    subjectKey: "name",
    // ⚠ `arguments` ALONE, NOT the whole bag — the opposite of the resource
    // read above, so `name` does NOT appear inside `params`. The two are
    // inconsistent in the producer the shapes came from; the inconsistency is
    // reproduced rather than tidied, because a consumer reading one producer
    // and a second producer reading the other must agree.
    startParams: (params) => ({
      params: paramsBag(params["arguments"] as Record<string, unknown> | undefined),
    }),
  },
];

/** Install every lifecycle seam. */
function installLifecycleSeams(lowLevel: RequestHandlerInternals, ctx: WrapContext): void {
  for (const spec of LIFECYCLE_SPECS) installLifecycleSeam(lowLevel, ctx, spec);
}

/** The subject member a `*_read` / `*_get` payload requires, as a string.
 *
 * ⚠ `String()` on a non-string would put `"[object Object]"` on the wire for a
 * malformed request — a value that reads like a real URI name and is not. The
 * empty string is what `baton-proxy` emits for an absent subject
 * (`str(params.get("uri") or "")`), so an unreadable one takes the same
 * spelling rather than inventing a third. The member is REQUIRED on all three
 * legs, so dropping it is not an option. */
function stringSubject(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `len(result[key])`, fail-safe. A result this seam cannot read is a count of
 * 0 rather than a dropped event: the call happened and its timing is the part
 * no other signal carries. */
function countOf(result: unknown, key: string): number {
  const list = (result as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(list) ? list.length : 0;
}

/** A `*_start` payload's `params` member: the caller's own request data.
 *
 * ⚠ **Does NOT scrub — `scrubLifecyclePayload` does, over the whole payload.**
 * A first version scrubbed only here, and the result was the worst of both: a
 * resource read of `file:///alice@corp.com/doc.txt` shipped the path REDACTED
 * inside `params` and RAW in the sibling `uri` member, in one event, so the
 * redaction was worthless for that value. Found by review, reproduced on both
 * majors. Scrubbing the whole payload is also what the producer these shapes
 * came from does (`emitter.py`: `payload = self._scrubber(payload)`), so it is
 * the parity position as well as the correct one.
 *
 * `_meta` is dropped: it rides the envelope as `runtime_meta`, where it is
 * coordinate-coarsened first (`roundMetaCoordinates`), so recording it here too
 * would put the same data on one event twice under two treatments — and the
 * coarsening would be the one a consumer could not rely on.
 *
 * ⚠ `{}` and not `null` for an absent bag, which is the proxy's spelling
 * (`dict(params) if params else {}` — it never emits null). The schema permits
 * both, so this is parity rather than conformance. */
function paramsBag(bag: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!bag || typeof bag !== "object") return {};
  // One loop rather than `Object.entries().filter().fromEntries()`, which
  // allocated a pair array per key plus two arrays and a closure to produce
  // what is usually a one-key copy — this runs on every `resources/read` and
  // every `prompts/get`.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(bag)) {
    if (key !== "_meta") out[key] = bag[key];
  }
  return out;
}

/**
 * Scrub a lifecycle payload WHOLE, then cap, and nothing else.
 *
 * ⚠ **Whole, not member by member** — the one rule this family needs and the
 * one a first version got wrong. `uri` and `name` are CALLER-supplied free
 * text (file paths, query strings, account ids, emails), not vendor-registered
 * identifiers like `tool_name`, and they ride all three legs. Scrubbing only
 * `params` left them raw while the same value was redacted one key over.
 *
 * It is also exactly what `baton_proxy.emitter._enqueue` does — one scrubber
 * pass over the whole payload dict — so the Console cannot receive a redacted
 * URI from one producer and a raw one from the other.
 *
 * ⚠ **Cap AFTER the scrub**, which is why the cap lives here rather than in a
 * caller: a PII value straddling `ERROR_BODY_MAX_CODE_POINTS` must reach the
 * scrubber whole, or the surviving half ships unredacted. Same ruling, same
 * reason, as `errorBody` for the tool-call legs — and the reason this path does
 * NOT call `errorBody`, which would scrub that one member a second time.
 *
 * ⚠ PRECONDITION: call this ONLY from inside an `emit()` build thunk. The bare
 * scrubber call is correct there — a throw drops the event, which is the right
 * answer for a payload — and wrong anywhere else (SPEC §11.2: a sensor never
 * breaks the vendor's call).
 */
function scrubLifecyclePayload(
  ctx: WrapContext,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw drops the event, which is correct for a payload
  const scrubbed = ctx.scrubber(raw) as Record<string, unknown>;
  const body = scrubbed?.["error_body"];
  if (typeof body !== "string") return scrubbed;
  // Spread rather than assign: the scrubber is the vendor's and may hand back
  // a frozen object. Key order does not matter — Zod emits in SHAPE order.
  return { ...scrubbed, error_body: capCodePoints(body, ERROR_BODY_MAX_CODE_POINTS) };
}

/** One tool's registry entry, in the only members either seam reads.
 *
 * The CLASSIFICATION members (`enabled`, `execution`) come from
 * `ToolEntryFacts` in `errorResult.ts`, which is where the decision that reads
 * them lives; this adds the two DISPATCH members, which only this module
 * touches. One declaration per fact, so the next flag either SDK branches on
 * cannot be added to one copy and missed in the other. */
interface ToolEntry extends ToolEntryFacts {
  handler?: unknown;
  executor?: unknown;
}

/**
 * The function an entry actually dispatches through, which differs by SDK
 * major — 1.x invokes `entry.handler`, v2 a closure at `entry.executor`.
 *
 * Shared by `wrapIfNeeded`, which tags it, and the `tools/call` seam, which
 * asks whether it is tagged. Two copies of this rule would let the seam
 * answer "not ours" about a tool `wrapIfNeeded` had in fact wrapped, and the
 * consequence is silent: the request-side `failure_kind` events for that tool
 * would simply never be emitted. See {@link wrapIfNeeded} for why getting the
 * per-major choice wrong fails quietly in the first place.
 */
function dispatchSlot(entry: ToolEntry): "executor" | "handler" | undefined {
  if (typeof entry.executor === "function") return "executor";
  if (typeof entry.handler === "function") return "handler";
  return undefined;
}

/** The dispatch target itself, for a caller that only needs to inspect it. */
function dispatchTarget(entry: ToolEntry): TaggedHandler | undefined {
  const slot = dispatchSlot(entry);
  return slot === undefined ? undefined : (entry[slot] as TaggedHandler);
}

/**
 * The `tools/call` REQUEST seam — the second of Baton's two tool-call
 * sensors, and the one that can see a failure the SDK manufactures ABOVE the
 * vendor's handler (SPEC §11.4.3's `failure_kind`).
 *
 * Three of those four failures emit NOTHING from the inner wrapper, because
 * the handler it wraps never runs: an unknown tool, a disabled tool and a
 * rejected argument. The fourth is worse than nothing — the handler returns
 * fine and the SDK's own output conversion rejects it, so the inner files
 * `tool_call_end` for a call the CALLER saw fail. This seam closes both: it
 * supplies the missing events itself, and it hands the inner's parked
 * terminal event the outcome so a false success can be replaced.
 *
 * ⚠ **Unconditional, unlike the `tools/list` seam** (which only installs
 * under `intentParamMode: "required"`): the correction it makes is not
 * configurable. A server with no reachable handler map gets no seam, and then
 * this producer has one seam again and correctly omits `failure_kind`
 * entirely — `CallSlot` and `terminate` carry that degradation.
 *
 * ⚠ **Fail-open, as the whole capture path must be (SPEC §11.2).** Both the
 * flush and the request-side emission go through `emit`, and `settleCall`'s
 * own guard is below; the vendor's result and the vendor's exception pass
 * through this seam untouched in every lane.
 */
function installToolsCallSeam(
  lowLevel: RequestHandlerInternals,
  toolEntry: (name: string) => ToolEntry | undefined,
  ctx: WrapContext,
): void {
  installRequestSeam(
    lowLevel,
    TOOLS_CALL_METHOD,
    TOOLS_CALL_SEAM,
    (handler) =>
      async (...args) => {
        const slot: CallSlot = { innerFired: false, flushTerminal: null };
        // Reassigned by both the try and the catch before `finally` reads it;
        // the initializer is for definite assignment, not a live default.
        let outcome: OuterOutcome = CLEAN_OUTCOME;
        try {
          const result = await callSlots.run(slot, () => handler(...args));
          outcome = { failed: isErrorResult(result), raised: false, result };
          return result;
        } catch (err) {
          outcome = { failed: true, raised: true, err };
          throw err;
        } finally {
          // ⚠ **`finally`, never a read after the `await`.** v2 THROWS a
          // `ProtocolError` out of this handler for an unknown or a disabled
          // tool (`mcp-DXXb3Vv3.mjs:1395-1397`), so a settle placed after the
          // await is skipped on exactly the two legs this seam exists for. A
          // probe made that mistake on 2026-10-01 and reported "the outer
          // never ran" as a blocker; the trap is in the production seam too,
          // which is why it is named here and not only in the design note.
          await settleCall(slot, outcome, args, toolEntry, ctx);
        }
      },
  );
}

/**
 * Decide what this call owes the event stream, now that both seams have had
 * their say.
 *
 * ⚠ Fail-open at the top level. Everything below is Baton's own bookkeeping
 * about a call that has already finished — a throw here would surface to the
 * agent as a failed tool call on work that succeeded, which SPEC §11.2
 * forbids outright. `emit` guards each individual event; this guards the
 * decision around them.
 */
async function settleCall(
  slot: CallSlot,
  outcome: OuterOutcome,
  args: AnyArgs,
  toolEntry: (name: string) => ToolEntry | undefined,
  ctx: WrapContext,
): Promise<void> {
  try {
    // The inner reached a terminal decision: flush it, or let the outcome
    // replace it. This is the ONLY path that emits a terminal event for a
    // call the vendor's handler actually ran.
    if (slot.flushTerminal !== null) {
      const flush = slot.flushTerminal;
      // ⚠ **Released BEFORE the await, not after — and not left set at all.**
      // The parked thunk captures this call's `result`, `params` and `extra`,
      // and on an `async_hooks`-backed `AsyncLocalStorage` the slot is copied
      // onto every async resource created inside `run`. So a vendor handler
      // that lazily makes a LONG-LIVED resource during the call (a pool, an
      // interval, a cached promise) pins the slot — and a slot still holding
      // the thunk drags that whole scope along for the resource's lifetime.
      // Clearing it bounds the retention to the dispatch.
      slot.flushTerminal = null;
      await flush(outcome);
      return;
    }
    // The handler ran but parked nothing — `openCall` itself threw. There is
    // no terminal event to flush and this is NOT a request-side failure: the
    // call got past the SDK's own checks. Saying nothing is the honest answer.
    if (slot.innerFired) return;
    // Nothing failed and the inner never fired: a tool this package does not
    // capture (the annotate tool, a task-based tool) was called and worked.
    if (!outcome.failed) return;
    await emitRequestSideFailure(outcome, args, toolEntry, ctx);
  } catch (err) {
    process.stderr.write(`baton: settling a tool call failed; events dropped: ${String(err)}\n`);
  }
}

/**
 * Emit the pair of events for a failure the SDK raised BEFORE the vendor's
 * handler ran (SPEC §11.4.3's three request-side `failure_kind`s).
 *
 * The inner wrapper emitted nothing at all for these, so this supplies both
 * legs, through the same `openCall` the inner uses — identical envelope,
 * identical `principal`, a minted `call_id` on the start so SPEC §11.5.4's
 * tier 1 pairs them.
 *
 * ⚠ **The start is not cosmetic.** `baton-console`'s pairer does build a row
 * from an orphan end (`correlate.py` emits `(None, i)`), but with no start it
 * has no `params` — and the arguments are precisely the diagnostic for
 * `invalid_argument`, the commonest of these three.
 *
 * Two callers get NO event, and both omissions are the point:
 *
 * - **Baton's own annotate tool.** It is excluded from `wrapIfNeeded` because
 *   it emits `annotation`, not `tool_call_*`; a rejected argument on it would
 *   otherwise file an `invalid_argument` about a tool the vendor does not own.
 * - **A registered tool this package did not wrap** — task-based tools, whose
 *   `.handler` is an object rather than a function. `wrapIfNeeded` leaves them
 *   alone rather than guessing at a shape we capture no events for, and this
 *   has to make the same choice or it would report failures for calls whose
 *   successes are invisible.
 *
 * An entry that is ABSENT is the opposite case and does get an event: that is
 * `unknown_tool`, where there is nothing to have wrapped.
 */
async function emitRequestSideFailure(
  outcome: OuterOutcome,
  args: AnyArgs,
  toolEntry: (name: string) => ToolEntry | undefined,
  ctx: WrapContext,
): Promise<void> {
  const request = args[0] as { params?: { name?: unknown; arguments?: unknown } } | undefined;
  const toolName = request?.params?.name;
  // A `tools/call` with no string tool name is not a call this sensor can
  // name, and SPEC gives `tool_name` no null spelling on any payload.
  if (typeof toolName !== "string") return;
  if (toolName === ctx.annotationToolName) return;
  const entry = toolEntry(toolName);
  // ⚠ `!= null`, so a null entry falls THROUGH to `unknown_tool` rather than
  // into `dispatchTarget`, where reading `.executor` off it would throw. The
  // registry is reached through a cast past the SDK's `private`, so its shape
  // is a declaration and not a runtime guarantee; `requestSideFailureKind`
  // makes the same check for the same reason, and it is this line that lets
  // that one be reached at all.
  if (entry != null && dispatchTarget(entry)?.[BATON_WRAPPED] !== true) return;

  // ⚠ A COPY, unlike the inner wrapper's in-place strip. `openCall` removes
  // Baton's injected intent params from whatever it is given, and here the
  // object is the vendor's live `request.params.arguments` — already consumed
  // by a validator that rejected it, so mutating it changes no outcome, but a
  // sensor that edits the request it is observing is a habit to refuse rather
  // than reason about once. The strip itself is required: these params ARE
  // still in the arguments on this path (validation runs above the executor,
  // and `captureAndInject` spliced the names into the schema), so without it
  // Baton's own params would land in `tool_call_start.params`, which SPEC
  // says equals the vendor-visible arguments.
  const params = { ...((request?.params?.arguments as Record<string, unknown>) ?? {}) };
  const { common, callId, sessionId } = await openCall(
    ctx,
    toolName,
    args[1] as Extra,
    params,
    entry != null,
  );

  // `undefined` where the SDK rejected the call for a reason this producer
  // cannot attribute — SPEC §11.4.3 permits omitting the member and
  // `requestSideFailureKind` says which shape that is. The event still goes:
  // the call failed, and the SDK's own message is on it.
  const failureKind: FailureKind | undefined = requestSideFailureKind(entry);
  await emit(ctx.sink, () =>
    ToolCallErrorEventSchema.parse({
      ...common,
      call_id: callId,
      sequence_number: ctx.counter.next(sessionId),
      captured_at: new Date().toISOString(),
      payload: {
        tool_name: toolName,
        // The lane the SDK rejected on, which is NOT the same across majors
        // for one failure: 1.x converts all three to a returned `isError`
        // inside its own `try` (`mcp.js:101-108`), v2 THROWS the first two
        // and returns the third. So the same customer-visible failure is
        // `"tool_error"` on one major and `"ProtocolError"` on the other —
        // measured 2026-10-01, and deliberately not special-cased: this
        // member is §11.4.3's RAISE/RETURN discriminator and it is reporting
        // the shape faithfully. `failure_kind` is what makes the two
        // comparable, which is the member's whole justification.
        error_type: outcome.raised ? errorTypeOf(outcome.err) : TOOL_ERROR_TYPE,
        // ⚠ `null`, not 0. The vendor's handler never ran, so there is no
        // handler duration to report; the time this call did spend was spent
        // in the SDK's validator, which is not what any other event means by
        // this member. §11.4 types it nullable for cases like this one.
        duration_ms: null,
        // ⚠ A CONDITIONAL SPREAD, not `failure_kind: failureKind`. Zod's
        // `.optional()` accepts `undefined` and keeps the KEY in its output,
        // so the plain form writes a present-but-undefined member — invisible
        // to a JSON-serialising sink and plainly visible to a vendor-supplied
        // one that iterates keys. SPEC §11.4.3 says a producer that cannot
        // determine the kind MUST OMIT the member, and omitting is what this
        // spells.
        ...(failureKind === undefined ? {} : { failure_kind: failureKind }),
        // KEPT under `"off"` — see `requestSideErrorFields`, which takes no
        // capture mode because nothing here is derived from a result.
        ...requestSideErrorFields(
          outcome.raised ? messageOf(outcome.err) : errorText(outcome.result),
          (text) => errorBody(ctx, text),
        ),
      },
    }),
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** Wrap the entry's CURRENT dispatch target iff it isn't already Baton's
 * wrapper. The `BATON_WRAPPED` tag lives on the wrapped FUNCTION, not the
 * entry object, so a `.update()` that swaps in a fresh vendor callback
 * (untagged) is correctly reprocessed, while one that leaves it alone is a
 * cheap no-op.
 *
 * WHICH function that is differs by SDK major, and getting it wrong fails
 * silently. 1.x's `tools/call` handler invokes `entry.handler`, so patching
 * that field intercepts the call. **v2 dispatches through `entry.executor`**
 * — a closure built at registration over the handler
 * (`createToolExecutor(inputSchema, handler)`; `executeToolHandler` is
 * literally `return tool.executor(args, ctx)`). Patching `entry.handler` on
 * v2 therefore does nothing at all: the vendor handler still runs, the
 * wrapper never fires, and the server emits zero events while looking
 * perfectly healthy — measured against `@modelcontextprotocol/server@2.0.0`
 * and pinned by `test/integrations/mcp/withBatonV2.test.ts`, whose RED
 * signature against a handler-only patch is an empty event list and no
 * error at all. Worse, the schema half
 * of `withBaton` keeps working, so a half-ported install would advertise
 * intent params, collect a goal from the agent, and capture none of it.
 *
 * On v2 we wrap the executor by capture-and-delegate, and deliberately do
 * NOT also wrap `entry.handler`: nothing dispatches through it there, and
 * tagging both would double-wrap once `update({callback})` regenerates the
 * executor over the untouched handler. */
function wrapIfNeeded(nameRef: { current: string }, entry: unknown, ctx: WrapContext): void {
  if (!entry || typeof entry !== "object") return;
  const mutable = entry as ToolEntry;

  // Task-based tools (experimental) carry an object, not a function, at
  // .handler — `dispatchTarget` answers `undefined` for them, and leaving
  // them untouched is deliberate rather than a gap: we capture no events for
  // that shape, and the `tools/call` seam makes the SAME choice off the SAME
  // predicate so it cannot report a failure for a tool whose successes are
  // invisible.
  // ⚠ The SLOT, not the target, so the rule is decided ONCE. An earlier
  // version called `dispatchTarget` and then re-tested
  // `typeof mutable.executor === "function"` to pick where to assign — which
  // is the rule in two spellings, in the one function whose docstring says
  // that is the failure mode.
  const slot = dispatchSlot(mutable);
  if (slot === undefined) return;
  const target = mutable[slot] as TaggedHandler;
  if (target[BATON_WRAPPED]) return;
  const wrapper = batonWrap(nameRef, target, ctx) as TaggedHandler;
  wrapper[BATON_WRAPPED] = true;
  mutable[slot] = wrapper;
}

function wireEntry(name: string, entry: unknown, ctx: WrapContext): void {
  if (name === ctx.annotationToolName) return;
  if (!entry || typeof entry !== "object") return;

  // First-time processing: inputSchema is guaranteed vendor-true (nothing
  // has injected into it yet) and the dispatch target is guaranteed
  // untagged, so both steps always apply together here — unlike the
  // .update() path below, which must reason about which one, if either,
  // actually needs to re-run.
  // The tool's CURRENT name. v2's `update({name})` re-keys `_registeredTools`
  // in place, keeping the same entry object AND its wrapper, so everything
  // below reads through this box rather than capturing the string.
  const nameRef = { current: name };

  captureAndInject(name, entry, ctx);
  wrapIfNeeded(nameRef, entry, ctx);

  if (wired.has(entry)) return;
  wired.add(entry);

  const removable = entry as { remove?: unknown };
  if (typeof removable.remove === "function") {
    const originalRemove = (removable.remove as () => void).bind(entry);
    (removable as { remove: () => void }).remove = () => {
      originalRemove();
      ctx.surfaceState.pruneTool(nameRef.current);
      ctx.paramRegistry.delete(nameRef.current);
    };
  }

  const updatable = entry as { update?: unknown };
  if (typeof updatable.update === "function") {
    const originalUpdate = (updatable.update as (updates: unknown) => void).bind(entry);
    (updatable as { update: (updates: unknown) => void }).update = (updates: unknown) => {
      const u = (updates ?? {}) as {
        paramsSchema?: unknown;
        name?: string | null;
        enabled?: boolean;
      };
      const renameTo = u.name;
      originalUpdate(updates);

      // v2 routes BOTH removal and rename through `update({name})` —
      // `remove()` is `update({name: null})`, and `disable()`/`enable()` are
      // `update({enabled})`. Handling only `paramsSchema` here would let a
      // v2 removal leave a phantom tool in the surface snapshot forever,
      // which is the exact defect the `.remove()` patch above exists to
      // prevent; a rename would strand the surface entry and the param
      // registry under the old key, and a stranded registry stops the strip
      // so Baton's own params would start reaching the vendor's handler.
      if (renameTo === null) {
        ctx.surfaceState.pruneTool(nameRef.current);
        ctx.paramRegistry.delete(nameRef.current);
        return;
      }
      if (typeof renameTo === "string" && renameTo !== nameRef.current) {
        ctx.surfaceState.renameTool(nameRef.current, renameTo);
        const dispositions = ctx.paramRegistry.get(nameRef.current);
        ctx.paramRegistry.delete(nameRef.current);
        if (dispositions) ctx.paramRegistry.set(renameTo, dispositions);
        nameRef.current = renameTo;
      }

      // Only re-capture+re-inject when THIS update actually replaced
      // inputSchema (mcp.js's own `typeof updates.paramsSchema !==
      // 'undefined'` gate) — otherwise inputSchema is still Baton's prior
      // injected version, not a fresh vendor-true one (see
      // captureAndInject's docstring for why re-running on that would
      // corrupt disposition tracking).
      if (u.paramsSchema !== undefined) {
        captureAndInject(nameRef.current, entry, ctx);
      }
      if (typeof u.enabled === "boolean") {
        ctx.surfaceState.setToolEnabled(nameRef.current, u.enabled);
      }

      // A callback swap always needs (re-)wrapping, independent of whether
      // the schema also changed — and on v2 a `paramsSchema` change needs it
      // too, because either one regenerates the executor over the vendor's
      // callback and discards our wrapper along with its tag.
      wrapIfNeeded(nameRef, entry, ctx);
    };
  }
}

/** The surface of a high-level MCP server `withBaton` actually uses. Written
 * structurally because the official SDK ships two nominally different
 * `McpServer` classes — 1.x's (`@modelcontextprotocol/sdk/server/mcp.js`)
 * and v2's (`@modelcontextprotocol/server`) — and both satisfy this. */
export interface SupportedMcpServer {
  readonly server: unknown;
  registerTool(name: string, ...rest: unknown[]): unknown;
}

/** Install Baton into an `McpServer`. See module docstring for usage. */
export function withBaton(server: SupportedMcpServer, supplied: BatonConfig = {}): BatonHandle {
  // ⚠ **FIRST — ahead of config resolution, every validation, and every
  // mutation of the vendor's server.** Off means install nothing and never
  // throw, so this cannot sit after a check that raises: a switch that can
  // still abort a vendor's boot is worse than no switch. It also has to
  // precede `resolveBatonConfig`, which would otherwise parse a DSN and
  // construct an `HttpSink` for capture that is not going to happen.
  const disabledBy = captureDisabled();
  if (disabledBy !== null) {
    logDisabled(disabledBy, "withBaton");
    return new BatonHandle({
      // A sink the VENDOR constructed is held rather than dropped, so their
      // `handle.aclose()` still releases it — we took ownership of that object
      // the moment they passed it, and the switch does not undo that. Nothing
      // writes to it: nothing is wrapped.
      sink: supplied.sink ?? new DisabledSink(),
      // Empty, and a constant, because when the switch is on nothing was
      // resolved: inventing a session id would put a real identifier on a
      // handle whose whole meaning is that no events exist under it.
      vendorId: "",
      sessionId: "baton-disabled",
      annotationToolName: "",
    });
  }
  return install(server, supplied, resolveBatonConfig(supplied), new Set());
}

/** One Baton for a process that builds a new `McpServer` for every request.
 * Owns the sink, so a request has nothing to close. */
export interface Baton {
  wrap(server: SupportedMcpServer): void;
  flush(): Promise<void>;
  aclose(): Promise<void>;
}

/** Create once at startup, then `wrap` each per-request server. For a server
 * that lives as long as the process, use `withBaton`. */
export function createBaton(supplied: BatonConfig = {}): Baton {
  const disabledBy = captureDisabled();
  if (disabledBy !== null) {
    logDisabled(disabledBy, "createBaton");
    const unused = supplied.sink ?? new DisabledSink();
    return { wrap: () => {}, flush: () => unused.flush(), aclose: () => unused.aclose() };
  }

  // Everything the environment or a bad config can decide is settled here, so
  // a request cannot fail on it or be switched off by it:
  // `createBaton.test.ts`, "reads the environment once".
  const resolved = resolveBatonConfig(supplied);
  deriveAnnotationToolName(resolved.vendorId, supplied.annotationToolName);
  const sink = resolved.sink ?? new StdoutSink();
  const config = {
    ...resolved,
    sink,
    tenantId: resolveTenantId(resolved.tenantId, resolved.vendorId),
  };
  const emittedSurfaceHashes = new Set<string>();
  return {
    wrap: (server) => {
      install(server, supplied, config, emittedSurfaceHashes);
    },
    flush: () => sink.flush(),
    aclose: () => sink.aclose(),
  };
}

function install(
  server: SupportedMcpServer,
  supplied: BatonConfig,
  resolved: ResolvedBatonConfig,
  emittedSurfaceHashes: Set<string>,
): BatonHandle {
  // The internals both majors keep off their public `.d.ts`, on one named
  // shape rather than an `any` per reach-in, so a future SDK rename is a
  // compile error here instead of a runtime surprise in five places.
  const internals = server as unknown as {
    server: { _instructions?: string; _serverInfo?: { name?: unknown } } & RequestHandlerInternals;
    registerTool: (...args: AnyArgs) => unknown;
    // `ToolEntry` and not `unknown`: the `tools/call` seam reads `enabled` and
    // the dispatch target off these entries, so an upstream rename of either
    // lands as a compile error here the way every other reach-in does.
    _registeredTools?: Record<string, ToolEntry>;
    _toolInputSchemaJson?: Record<string, unknown>;
    toolInputSchemaJson?: (name: string) => Record<string, unknown> | undefined;
  };

  // The name the vendor gave this server, read once for both cosmetic labels:
  // the display name (only when a DSN is given) and the annotation tool name.
  // `_serverInfo` is where both majors keep what the constructor was handed;
  // the guards live in `annotationName.ts`.
  const serverName = usableServerName(() => ({
    name: internals.server._serverInfo?.name,
    className: internals.constructor.name,
  }));

  const config = withServerDisplayName(resolved, supplied, serverName);
  const sink = config.sink ?? new StdoutSink();
  // Resolved ONCE and threaded to every consumer below: the wrapper's skip of
  // the annotate tool, the instructions, the registration and the handle. With
  // the server's name as an input, two resolutions could register one name
  // while the wrapper skips another and the instructions cite a third.
  const annotationToolName = resolveAnnotationToolName(serverName, config);
  // "required" by default since 2026-09-15 (Ujwal, #features): advertised
  // through the `tools/list` seam, never enforced, so the default asks every
  // agent for `user_goal` and refuses no call that omits it.
  const intentParamMode: IntentParamMode = config.intentParamMode ?? "required";
  const counter = new SessionCounter();
  const fallbackSessionId = `sdk-${uuid7()}`;
  // Resolved ONCE, here, and read by every emit path below — the tool-call
  // wrapper (via `ctx`), the annotation tool (via `registerAnnotationTool`)
  // and `emitSurface`, which builds its envelope from `config` directly.
  // Two resolutions could disagree, and an annotation landing under a
  // different tenant than the call it annotates is unjoinable.
  const tenantId = resolveTenantId(config.tenantId, config.vendorId);
  // Default ON, mirroring Python's `install_baton` (`config.scrubber or
  // Scrubber()`). One instance per install, reused for every event, so its
  // `counts` accumulate across the session the way Python's does.
  const scrubber = config.scrubber ?? new Scrubber().scrub;

  // Vendor-true baseline, captured BEFORE any Baton mutation below —
  // MUST run before the instructions assignment, or the snapshot would
  // capture Baton's own text instead of the vendor's. See module docstring.
  const serverMeta = buildServerMeta(server.server);
  const surfaceState = new SurfaceState(serverMeta, emittedSurfaceHashes);

  const emitSurface = async (
    sessionId: string,
    digest: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> => {
    // NOT `emit()`'s fail-open wrapper — this deliberately lets a write
    // failure propagate so maybeEmitSurfaceSnapshot can tell success from
    // failure and retry on the next call rather than silently treating the
    // surface as emitted. The caller still fails open overall (SPEC
    // §11.2): it catches this and never lets it reach the vendor's call.
    // Deliberately NOT scrubbed — this is the vendor's own static tool
    // surface, not caller-supplied data (mirrors Python's emit_surface).
    const event = SurfaceSnapshotEventSchema.parse({
      tenant_id: tenantId,
      vendor_id: config.vendorId,
      session_id: sessionId,
      consent_token: config.consentToken,
      sequence_number: counter.next(sessionId),
      captured_at: new Date().toISOString(),
      // Deliberately the literal, NOT the ladder — and an earlier comment
      // here justified that by saying no call is in scope, which is false:
      // `maybeEmitSurfaceSnapshot` is the first line of `batonWrap`, so the
      // handshake has happened and tier 2's carrier is live in this closure.
      // The real reason is that the snapshot describes the VENDOR'S SURFACE,
      // which is the same whoever is calling. It is hashed and emitted at
      // most once per process per surface, so the client that happens to
      // trigger it is whichever one called first — attributing the surface to
      // that client would read as a fact about the surface and be an accident
      // of timing. Python hardcodes it from the same in-call position
      // (`_tool_wrap.py`), so this is parity, not a gap.
      //
      // ⚠ Consequence worth knowing: one session emits `surface_snapshot`
      // with `unknown` and everything else with the client's name, so a
      // consumer grouping on `agent_runtime` alone sees two runtimes for one
      // client. Intended; group surfaces on `(tenant_id, vendor_id,
      // surface_hash)`, which is what the Console's table is keyed on.
      agent_runtime: UNKNOWN_AGENT_RUNTIME,
      payload: {
        surface_hash: digest,
        server_info: snapshot.server_info,
        capabilities: snapshot.capabilities,
        instructions: snapshot.instructions,
        tools: snapshot.tools,
        seam_augmentations: snapshot.seam_augmentations,
      },
    });
    await sink.write(event);
  };

  // v2 memoises each tool's converted JSON Schema at registration
  // (`_toolInputSchemaJson`). `tools/list` re-converts and so never reads it,
  // but the HTTP entry's SEP-2243 `Mcp-Param-*` PRE-DISPATCH validation does
  // (`createMcpHandler`) — so leaving it stale after we mutate `inputSchema`
  // would make injected params work over stdio and vanish over HTTP, per
  // transport, silently. `update({paramsSchema})` deletes the key itself;
  // a direct assignment is ours to clean up.
  const bustSchemaMemo = (name: string): void => {
    const memo = internals._toolInputSchemaJson;
    if (memo && typeof memo === "object") delete memo[name];
  };

  // Vendor-true JSON Schema for the surface snapshot. v2 renders `tools/list`
  // from its own converter (draft-2020-12, `$schema` included), so reading
  // its memo — which at call time still holds the pre-injection conversion —
  // keeps surface.ts's byte-for-byte promise true there. 1.x has no such
  // reader, and its own `toJsonSchemaCompat` is the matching conversion.
  const isV2Server = typeof internals.toolInputSchemaJson === "function";
  const vendorToolJsonSchema = (name: string, inputSchema: unknown): Record<string, unknown> => {
    if (isV2Server) {
      try {
        const json = internals.toolInputSchemaJson!(name);
        if (json) return json;
      } catch {
        // Fall through.
      }
      // The reader returns `undefined` for a tool that is currently DISABLED,
      // so a tool captured while disabled would otherwise land on the 1.x
      // converter and put a draft-07 `$schema` in a snapshot whose other
      // tools are draft-2020-12 — two spellings in one hash, from one server.
      // The schema's own Standard-Schema converter is the one v2 renders
      // with; verified canonically equal to the wire output.
      try {
        const standard = (inputSchema as { "~standard"?: { jsonSchema?: { input?: (o: unknown) => Record<string, unknown> } } })?.["~standard"];
        const json = standard?.jsonSchema?.input?.({ target: "draft-2020-12" });
        if (json) return json;
      } catch {
        // Fall through.
      }
    }
    try {
      return toolInputJsonSchema(inputSchema);
    } catch {
      // noteTool sits outside captureAndInject's try, and it runs inside the
      // vendor's own registerTool call — a throw here would surface as their
      // registration failing. A schema we cannot convert costs the snapshot
      // one tool's schema, nothing else — spelled the way both majors spell
      // an empty one, not as a third `{}`.
      return { type: "object", properties: {} };
    }
  };

  const tracker = new ProactiveTracker();
  const ctx: WrapContext = {
    sink,
    counter,
    tenantId,
    vendorId: config.vendorId,
    consentToken: config.consentToken,
    fallbackSessionId,
    server,
    scrubber,
    annotationToolName,
    intentParamMode,
    resultCaptureMode: config.resultCaptureMode ?? "full",
    paramRegistry: new Map(),
    resolvePrincipal: config.resolvePrincipal,
    vendorToolJsonSchema,
    bustSchemaMemo,
    tracker,
    surfaceState,
    emitSurface,
  };

  // Server instructions — load-bearing on instruction-aware runtimes (SPEC
  // §5.1.2). No public setter exists post-construction; see module
  // docstring for why this reach-in has no "preferred path" to fall back
  // from, unlike Python's adapter.
  const instructions = buildServerInstructions({
    vendorDisplayName: config.vendorDisplayName,
    annotationToolName,
  });
  internals.server._instructions = instructions;

  // Before the annotate tool registers: on a server with no tools yet, that
  // registration is what makes the SDK install its `tools/list` handler, and
  // the seam has to be in place to wrap it as it lands.
  if (intentParamMode === "required") installToolsListSeam(internals.server, ctx);

  // The SECOND tool-call seam (SPEC §11.4.3's `failure_kind`) — unconditional,
  // and installed here for the same reason the `tools/list` seam is: the
  // annotate tool's registration below is what makes a toolless server install
  // its tool handlers at all, so the seam has to be in place to wrap one as it
  // lands.
  //
  // ⚠ The registry is read PER CALL, not captured, so a tool removed after
  // install classifies as `unknown_tool` rather than against a stale snapshot
  // — `update({name: null})` and `remove()` both delete the entry, and the
  // whole point of this lookup is to agree with what the SDK itself just read.
  installToolsCallSeam(
    internals.server,
    // ⚠ `Object.hasOwn`, never a bare index. `_registeredTools` is a plain
    // object, so `registry["constructor"]` answers `Object` and
    // `registry["__proto__"]` answers `Object.prototype` — both non-undefined,
    // so the "a tool we did not wrap" guard would decline to report, and a
    // caller-visible `Tool constructor disabled` would reach the client with
    // this seam silent. An agent hallucinating a prototype-shaped tool name is
    // exactly the kind of failure the seam exists to make visible.
    (name) => {
      const registry = internals._registeredTools;
      return registry && Object.hasOwn(registry, name) ? registry[name] : undefined;
    },
    ctx,
  );

  // The four resource/prompt lifecycle seams (SPEC §11.4.4) — unconditional,
  // like the seam above, because what they capture is not configurable.
  //
  // ⚠ **Install ORDER is irrelevant for these four, unlike the two above.**
  // `resources/*` and `prompts/*` handlers are installed by the vendor's own
  // `registerResource` / `registerPrompt`, not by the annotate-tool
  // registration below — and `installRequestSeam` patches `setRequestHandler`,
  // so a primitive registered AFTER `withBaton` is seamed as its handler
  // lands. Verified on both majors. This paragraph used to claim the
  // annotate-tool ordering mattered here, which was the `tools/*` seams'
  // reason copied one function too far.
  installLifecycleSeams(internals.server, ctx);

  const resolvedAnnotationToolName = registerAnnotationTool(server, {
    sink,
    counter: ctx.counter,
    tenantId: ctx.tenantId,
    vendorId: ctx.vendorId,
    vendorDisplayName: config.vendorDisplayName,
    consentToken: ctx.consentToken,
    resolvePrincipal: ctx.resolvePrincipal,
    fallbackSessionId: ctx.fallbackSessionId,
    scrubber: ctx.scrubber,
    // The RESOLVED name, never `config.annotationToolName`: handing over the
    // raw override and letting the registration re-derive would register
    // `srv-..._annotate` while the instructions name the server-derived one.
    annotationToolName,
    tracker,
  });

  // Retroactive: sweep whatever's already registered, regardless of call order.
  const existing = internals._registeredTools;
  if (existing) {
    for (const [name, entry] of Object.entries(existing)) {
      wireEntry(name, entry, ctx);
    }
  }

  // Prospective: every future registration goes through here too. Patched
  // AFTER registerAnnotationTool runs above (deliberately) — the annotate
  // tool registration hits the original, unpatched registerTool, lands in
  // _registeredTools, and gets excluded by name in the retroactive sweep
  // just above instead. Patching registerTool before registering the
  // annotate tool would work too (wireEntry's name check guards either
  // order), but this ordering means the annotate tool only ever needs to
  // be excluded in the one place, not reasoned about twice.
  const originalRegisterTool = internals.registerTool.bind(server);
  internals.registerTool = (...args: AnyArgs) => {
    const registered = originalRegisterTool(...args);
    wireEntry(String(args[0]), registered, ctx);
    return registered;
  };

  return new BatonHandle({
    sink,
    vendorId: config.vendorId,
    sessionId: fallbackSessionId,
    annotationToolName: resolvedAnnotationToolName,
  });
}
