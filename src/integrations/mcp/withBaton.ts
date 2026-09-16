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
 * `tool_call_error`, injects server `instructions` (SPEC §5.1.2), registers
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

import { v7 as uuidv7 } from "uuid";
import {
  AnnotationEventSchema,
  SurfaceSnapshotEventSchema,
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  ToolCallStartEventSchema,
} from "../../events.js";
import { StdoutSink, type Sink } from "../../sinks.js";
import { registerAnnotationTool } from "./annotation.js";
import { Scrubber } from "../../scrub.js";
import { roundMetaCoordinates } from "../../metaCoordinates.js";
import {
  resolveBatonConfig,
  resolveTenantId,
  resolvePrincipalIdHmacKey,
  type BatonConfig,
} from "./config.js";
import { captureDisabled, DisabledSink, logDisabled } from "../../optout.js";
import { emit } from "./emit.js";
import { BatonHandle } from "./handle.js";
import { resolveAnnotationToolName, usableServerName } from "./annotationName.js";
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
  resolveCallPrincipalId,
  warnIfIdentityCannotResolve,
} from "./principalResolution.js";
import type { PrincipalIdMode } from "../../identity.js";
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
  principalIdMode: PrincipalIdMode;
  principalIdHmacKey: string | Uint8Array | undefined;
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
// reach-in is declared on a named local shape (`internals` in `withBaton`,
// the small casts in `wrapIfNeeded`/`captureAndInject`) rather than an
// `any`, so a rename upstream lands as a compile error here.

const BATON_WRAPPED = Symbol("batonWrapped");
const wired = new WeakSet<object>();

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
  readonly emittedHashes = new Set<string>();
  dirty = false;

  constructor(private readonly serverMeta: ReturnType<typeof buildServerMeta>) {}

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

/** `nameRef` is read on every call, not captured: v2's `update({name})`
 * renames a tool in place, keeping the same entry object AND the same
 * executor, so a wrapper that closed over the registration-time string would
 * keep emitting events under the old `tool_name` and keep missing its own
 * param-registry entry — which downgrades the strip to the cold-registry
 * path and puts a warning on the vendor's stderr for every call. */
function batonWrap(nameRef: { current: string }, original: AnyHandler, ctx: WrapContext): AnyHandler {
  return async (...callArgs: AnyArgs): Promise<unknown> => {
    const toolName = nameRef.current;
    await maybeEmitSurfaceSnapshot(ctx);

    const extra = callArgs[callArgs.length - 1] as Extra;
    // 1.x calls a schema-less tool as `(extra)`; v2 always calls its
    // executor `(args, ctx)` and passes `args === undefined` for one. Both
    // land on `{}` here — and the ORIGINAL `callArgs` is what gets
    // delegated, so the arity fork stays inside the callee either way.
    const params = ((callArgs.length > 1 ? callArgs[0] : undefined) ?? {}) as Record<
      string,
      unknown
    >;
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
    const scrubbedMeta = meta
      ? (ctx.scrubber(roundMetaCoordinates(meta)) as Record<string, unknown>)
      : null;
    const sessionId = await resolveSessionId(ctx.fallbackSessionId, extra);

    // Strip the injected goal params IN PLACE, before snapshotting params —
    // `params` is the SAME object forwarded to the vendor handler, so the
    // strip keeps user_goal/expected_result off the tool AND out of the
    // captured `params` (which must equal the vendor-visible arguments).
    const dispositions = ctx.paramRegistry.get(toolName);
    const rawIntent = extractGoalParam(params, USER_GOAL_PARAM_NAME, toolName, dispositions);
    const rawExpected = extractGoalParam(
      params,
      EXPECTED_RESULT_PARAM_NAME,
      toolName,
      dispositions,
    );
    const rawWorkflow = extractGoalParam(params, OVERALL_TASK_PARAM_NAME, toolName, dispositions);
    const scrubbedIntent = rawIntent !== null ? (ctx.scrubber(rawIntent) as string) : null;
    const scrubbedExpected = rawExpected !== null ? (ctx.scrubber(rawExpected) as string) : null;
    // Scrubbed like the other two. Deterministic redaction preserves the
    // exact-string continuity rung 3b groups on: the same label scrubs to
    // the same output on every call.
    const scrubbedWorkflow = rawWorkflow !== null ? (ctx.scrubber(rawWorkflow) as string) : null;

    // The per-call correlation key, minted HERE — in the one scope that emits
    // both legs — so start and end carry the same value by construction. It
    // is deliberately NOT part of `common`: `common` is also spread into the
    // proactive annotation below, and SPEC defines no `call_id` for an
    // annotation. Stamped onto the three tool-call events individually.
    const callId = uuidv7();

    // Resolved AFTER the intent-param strip, so the hook's `arguments` are
    // exactly what the vendor's own handler receives — Baton's injected
    // params are never a caller's input and must not look like one.
    const principalId = await resolveCallPrincipalId(
      ctx.resolvePrincipal,
      { extra, toolName, arguments: params },
      { mode: ctx.principalIdMode, tenantId: ctx.tenantId, key: ctx.principalIdHmacKey },
    );

    const common = {
      tenant_id: ctx.tenantId,
      vendor_id: ctx.vendorId,
      session_id: sessionId,
      consent_token: ctx.consentToken,
      agent_runtime: runtime,
      // The four `...common` sites below are the tool-call legs and the
      // proactive annotation — the same four Python stamps
      // (`middleware.py` 481/524/562/606). `surface_snapshot` is deliberately
      // NOT among them: it describes the SERVER and is captured outside any
      // call, so there is no caller to name (register D5).
      principal_id: principalId,
      // Same four stamps, same exclusion: a surface_snapshot describes the
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
          params: ctx.scrubber(params),
          call_intent: scrubbedIntent,
          call_expected: scrubbedExpected,
          call_workflow: scrubbedWorkflow,
          intent_source: scrubbedIntent !== null ? INTENT_SOURCE_PARAM : null,
        },
      }),
    );

    const startedAt = performance.now();
    let result: unknown;
    try {
      result = await original(...callArgs);
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      const message = err instanceof Error ? err.message : String(err);
      await emit(ctx.sink, () =>
        ToolCallErrorEventSchema.parse({
          ...common,
          call_id: callId,
          sequence_number: ctx.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          payload: {
            tool_name: toolName,
            error_type: err instanceof Error ? err.constructor.name : "Error",
            error_body: String(ctx.scrubber(message)).slice(0, 2000),
            duration_ms: durationMs,
          },
        }),
      );
      throw err;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    await emit(ctx.sink, () =>
      ToolCallEndEventSchema.parse({
        ...common,
        call_id: callId,
        sequence_number: ctx.counter.next(sessionId),
        captured_at: new Date().toISOString(),
        payload: { tool_name: toolName, result: ctx.scrubber(result), duration_ms: durationMs },
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
): string | null {
  if (!(paramName in args)) return null;
  const disposition = dispositions ? dispositions[paramName] : undefined;
  if (disposition === "native") return null;
  if (disposition === undefined) {
    process.stderr.write(
      `baton: stripping ${paramName} from unlisted tool ${JSON.stringify(toolName)} (cold registry)\n`,
    );
  }
  const raw = args[paramName];
  delete args[paramName];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/** Lazy, fail-open surface_snapshot capture — the first tool call after any
 * registration change re-hashes the surface and emits iff the hash hasn't
 * been seen before. `dirty` is cleared FIRST so a hashing/serialization
 * error (deterministic — would just re-throw identically every call) costs
 * one attempt per surface change, not a retry storm. A WRITE failure is
 * different (sink health can recover), so that path re-sets `dirty = true`
 * to retry on the next call; `emittedHashes` only gains an entry AFTER a
 * successful write, so a transient failure can't permanently drop a
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
  if (ctx.surfaceState.emittedHashes.has(digest)) return;
  const seam = buildSeamAugmentations({
    injectedToolNames: [ctx.annotationToolName],
    intentParamNames: [USER_GOAL_PARAM_NAME, EXPECTED_RESULT_PARAM_NAME, OVERALL_TASK_PARAM_NAME],
    intentParamMode: ctx.intentParamMode,
  });
  try {
    await ctx.emitSurface(ctx.fallbackSessionId, digest, { ...snapshot, seam_augmentations: seam });
  } catch (err) {
    process.stderr.write(`baton: surface snapshot capture failed: ${String(err)}\n`);
    ctx.surfaceState.dirty = true;
    return;
  }
  ctx.surfaceState.emittedHashes.add(digest);
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

/** The two request-handler internals the `tools/list` seam reaches, shared
 * by both majors' `Protocol`: the per-method dispatch map, and the setter
 * that fills it. Typed `unknown` and checked at install, so a server laid out
 * differently gets no seam rather than a crash. */
interface ToolsListInternals {
  _requestHandlers?: unknown;
  setRequestHandler?: unknown;
}

const TOOLS_LIST_METHOD = "tools/list";
const TOOLS_LIST_SEAM = Symbol("batonToolsListSeam");
type SeamedHandler = AnyHandler & { [TOOLS_LIST_SEAM]?: boolean };

/**
 * The `tools/list` RESPONSE seam, which is what lets `intentParamMode:
 * "required"` advertise `user_goal` as required without the validator
 * enforcing it (see `schemaCompat.buildIntentFields` for why zod cannot).
 *
 * Both majors dispatch requests through `server.server._requestHandlers`, a
 * `Map` keyed by method and read per request (1.x `shared/protocol.js`
 * `_onrequest`; v2 `Protocol._onrequest`), and both `McpServer`s install
 * their `tools/list` handler lazily, on the first `registerTool` (v2 also
 * eagerly, when constructed with a `tools` capability). So both orders are
 * covered: a handler already in the map is wrapped now, and
 * `setRequestHandler` is patched so one set later is wrapped as it lands.
 * Keyed on the map entry rather than on the setter's arguments, because the
 * majors spell the method differently (a zod schema on 1.x, a string on v2)
 * and both land in the same map.
 *
 * ⚠ Fail-open, twice. A throw from the transform is logged and the SDK's own
 * result goes out untouched, because a vendor's `tools/list` may never break
 * on Baton's account. And a server whose internals do not have this shape
 * gets no seam at all, which costs the advertisement and nothing else.
 */
function installToolsListSeam(lowLevel: ToolsListInternals, ctx: WrapContext): void {
  const table = lowLevel._requestHandlers;
  const originalSet = lowLevel.setRequestHandler;
  if (!(table instanceof Map) || typeof originalSet !== "function") return;
  const handlers = table as Map<string, unknown>;
  const setRequestHandler = originalSet as AnyHandler;

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

  const wrapCurrent = (): void => {
    const handler = handlers.get(TOOLS_LIST_METHOD) as SeamedHandler | undefined;
    if (typeof handler !== "function" || handler[TOOLS_LIST_SEAM]) return;
    const seamed: SeamedHandler = (...args: AnyArgs) => {
      const out = handler(...args);
      return isThenable(out) ? out.then(advertise) : advertise(out);
    };
    seamed[TOOLS_LIST_SEAM] = true;
    handlers.set(TOOLS_LIST_METHOD, seamed);
  };

  wrapCurrent();
  lowLevel.setRequestHandler = (...args: AnyArgs): unknown => {
    const registered = setRequestHandler.apply(lowLevel, args);
    wrapCurrent();
    return registered;
  };
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
  const mutable = entry as { handler: unknown; executor?: unknown };

  if (typeof mutable.executor === "function") {
    if ((mutable.executor as TaggedHandler)[BATON_WRAPPED]) return;
    const originalExecutor = mutable.executor as AnyHandler;
    const wrapper = batonWrap(nameRef, originalExecutor, ctx) as TaggedHandler;
    wrapper[BATON_WRAPPED] = true;
    mutable.executor = wrapper;
    return;
  }

  // Task-based tools (experimental) carry an object, not a function, at
  // .handler — leave them untouched rather than guess at wrapping a shape
  // we don't capture events for yet.
  if (typeof mutable.handler !== "function") return;
  if ((mutable.handler as TaggedHandler)[BATON_WRAPPED]) return;
  const original = mutable.handler as AnyHandler;
  const wrapper = batonWrap(nameRef, original, ctx) as TaggedHandler;
  wrapper[BATON_WRAPPED] = true;
  mutable.handler = wrapper;
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

  // The internals both majors keep off their public `.d.ts`, on one named
  // shape rather than an `any` per reach-in, so a future SDK rename is a
  // compile error here instead of a runtime surprise in five places.
  const internals = server as unknown as {
    server: { _instructions?: string; _serverInfo?: { name?: unknown } } & ToolsListInternals;
    registerTool: (...args: AnyArgs) => unknown;
    _registeredTools?: Record<string, unknown>;
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

  // Shadowed deliberately: every path below — the tool wrappers, the
  // annotation tool, the surface snapshot — closes over `config`, and one of
  // them reading the caller's raw object would emit its events under a
  // different identity than the rest. `ResolvedBatonConfig`'s required fields
  // are what make that a compile error rather than a review question.
  //
  // The parameter defaults to `{}` so `withBaton(server)` works when
  // `BATON_DSN` is exported — the hosted-vendor shape, and Python's
  // `install_baton(mcp)` with nothing but the environment.
  const config = resolveBatonConfig(supplied, serverName);
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
  const fallbackSessionId = `sdk-${uuidv7()}`;
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
  const surfaceState = new SurfaceState(serverMeta);

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
    paramRegistry: new Map(),
    resolvePrincipal: config.resolvePrincipal,
    principalIdMode: config.principalIdMode ?? "hashed",
    principalIdHmacKey: resolvePrincipalIdHmacKey(config.principalIdHmacKey),
    vendorToolJsonSchema,
    bustSchemaMemo,
    tracker,
    surfaceState,
    emitSurface,
  };

  // Install-time, not per-call: all three inputs are resolved above and cannot
  // change for the life of this server. See `warnIfIdentityCannotResolve` for
  // why the silent-success case is the one that needs saying out loud.
  warnIfIdentityCannotResolve(ctx);

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

  const resolvedAnnotationToolName = registerAnnotationTool(server, {
    sink,
    counter: ctx.counter,
    tenantId: ctx.tenantId,
    vendorId: ctx.vendorId,
    vendorDisplayName: config.vendorDisplayName,
    consentToken: ctx.consentToken,
    // Read off `ctx`, never re-resolved from `config`: the two paths must
    // agree on the actor, and `principalIdMode`/`principalIdHmacKey` each have a
    // default and an env fallback that a second resolution could take
    // differently. Required (not optional) on the options type ON PURPOSE —
    // the compiler then refuses a registration that forgets them, which is
    // the mechanical version of "wiring two of four call sites".
    resolvePrincipal: ctx.resolvePrincipal,
    principalIdMode: ctx.principalIdMode,
    principalIdHmacKey: ctx.principalIdHmacKey,
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
