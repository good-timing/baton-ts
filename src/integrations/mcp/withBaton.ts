/**
 * `withBaton` — the vendor's MCP integration entry point for the official
 * `@modelcontextprotocol/sdk`'s high-level `McpServer`.
 *
 * ```typescript
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { withBaton } from "@baton/sdk";
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
 * `expected_result` intent params on every wrapped tool's schema (SPEC
 * §11.4.1 `call_intent`/`intent_source`), and captures a `surface_snapshot`
 * of the vendor-true surface. Every payload leaving here runs through the
 * configured scrubber, which defaults to the shipped ruleset (`src/scrub.ts`)
 * — see README "What's deferred" for what's still not here (the low-level
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
 * the surface snapshot forever. Known gap: a `.update()` that also renames
 * the tool isn't reconciled against the surface/param-registry keys, which
 * stay under the old name — an unusual vendor pattern, not handled here.
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

import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { validateBatonConfig, type BatonConfig } from "./config.js";
import { emit } from "./emit.js";
import { BatonHandle } from "./handle.js";
import { buildServerInstructions } from "./llmText.js";
import {
  EXPECTED_RESULT_PARAM_NAME,
  INTENT_SOURCE_PARAM,
  USER_GOAL_PARAM_NAME,
} from "./llmText.js";
import type { Extra } from "./mcpTypes.js";
import { ProactiveTracker } from "./proactiveTracker.js";
import { detectAgentRuntime } from "./runtimeAdapter.js";
import { resolveSessionId } from "./sessionResolution.js";
import { SessionCounter } from "./sessionCounter.js";
import {
  injectGoalParams,
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
  defaultAgentRuntime: string;
  scrubber: (value: unknown) => unknown;
  resolveSessionId: BatonConfig["resolveSessionId"];
  annotationToolName: string;
  intentParamMode: IntentParamMode;
  paramRegistry: Map<string, IntentParamDispositions>;
  tracker: ProactiveTracker;
  surfaceState: SurfaceState;
  emitSurface: (
    sessionId: string,
    digest: string,
    snapshot: Record<string, unknown>,
  ) => Promise<void>;
}

// `_registeredTools`, `RegisteredTool.handler`, `server.server._instructions`,
// and `server.server._serverInfo` are internal to @modelcontextprotocol/sdk,
// not part of its public .d.ts surface. Reaching into them is deliberate
// (see module docstring) and requires stepping outside the type system the
// same way Python's _registry.py does — isolated to this one module so a
// future SDK internals change has exactly one place to update.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

const BATON_WRAPPED = Symbol("batonWrapped");
const wired = new WeakSet<object>();

/** Tracks the vendor-true (pre-injection) tool surface for this install, for
 * `surface_snapshot` capture. Built from data already in hand at wrap time
 * and lazily hashed+emitted on the next tool call — mirrors the official
 * mcp SDK's Python adapter, which has the same "no tools/list hook"
 * constraint and makes the same lazy-on-first-call choice for the same
 * reason (see `project_sdk_sensor_parity_gap` memory). */
class SurfaceState {
  readonly rawTools = new Map<string, Record<string, unknown>>();
  readonly emittedHashes = new Set<string>();
  dirty = false;

  constructor(private readonly serverMeta: ReturnType<typeof buildServerMeta>) {}

  noteTool(name: string, inputSchema: unknown, description: string | undefined): void {
    this.rawTools.set(name, {
      name,
      description: description ?? null,
      inputSchema: toolInputJsonSchema(inputSchema),
    });
    this.dirty = true;
  }

  pruneTool(name: string): void {
    if (this.rawTools.delete(name)) this.dirty = true;
  }

  buildSnapshot(): Record<string, unknown> {
    const names = [...this.rawTools.keys()].sort();
    return assembleSurface(
      this.serverMeta,
      names.map((n) => this.rawTools.get(n)!),
    );
  }
}

function batonWrap(toolName: string, original: AnyHandler, ctx: WrapContext): AnyHandler {
  return async (...callArgs: AnyArgs): Promise<unknown> => {
    await maybeEmitSurfaceSnapshot(ctx);

    const extra = callArgs[callArgs.length - 1] as Extra;
    const params = (callArgs.length > 1 ? callArgs[0] : {}) as Record<string, unknown>;
    const meta = (extra._meta as Record<string, unknown> | undefined) ?? null;
    const runtime = detectAgentRuntime(meta) ?? ctx.defaultAgentRuntime;
    const scrubbedMeta = meta ? (ctx.scrubber(meta) as Record<string, unknown>) : null;
    const sessionId = await resolveSessionId(
      ctx.resolveSessionId,
      ctx.fallbackSessionId,
      extra,
      meta,
      toolName,
      params,
    );

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
    const scrubbedIntent = rawIntent !== null ? (ctx.scrubber(rawIntent) as string) : null;
    const scrubbedExpected = rawExpected !== null ? (ctx.scrubber(rawExpected) as string) : null;

    const common = {
      tenant_id: ctx.tenantId,
      vendor_id: ctx.vendorId,
      session_id: sessionId,
      consent_token: ctx.consentToken,
      agent_runtime: runtime,
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
        sequence_number: ctx.counter.next(sessionId),
        captured_at: new Date().toISOString(),
        payload: {
          tool_name: toolName,
          params: ctx.scrubber(params),
          call_intent: scrubbedIntent,
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
    intentParamNames: [USER_GOAL_PARAM_NAME, EXPECTED_RESULT_PARAM_NAME],
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
  const mutable = entry as { inputSchema?: unknown; description?: string };
  ctx.surfaceState.noteTool(name, mutable.inputSchema, mutable.description);
  if (ctx.intentParamMode === "off") return;
  try {
    const { schema, dispositions } = injectGoalParams(mutable.inputSchema, ctx.intentParamMode);
    if (Object.keys(dispositions).length > 0) {
      mutable.inputSchema = schema;
      ctx.paramRegistry.set(name, dispositions);
    } else {
      ctx.paramRegistry.delete(name);
    }
  } catch {
    // Fail open — a schema this module can't handle just skips injection
    // for this tool; capture/wrap of the tool itself is unaffected.
  }
}

/** Wrap the entry's CURRENT handler iff it isn't already Baton's wrapper.
 * The `BATON_WRAPPED` tag lives on the handler FUNCTION, not the entry
 * object, so a `.update()` that swaps in a fresh vendor callback (untagged)
 * is correctly reprocessed, while one that leaves the handler alone is a
 * cheap no-op. */
function wrapIfNeeded(name: string, entry: unknown, ctx: WrapContext): void {
  if (!entry || typeof entry !== "object") return;
  const mutable = entry as { handler: unknown };
  // Task-based tools (experimental) carry an object, not a function, at
  // .handler — leave them untouched rather than guess at wrapping a shape
  // we don't capture events for yet.
  if (typeof mutable.handler !== "function") return;
  if ((mutable.handler as TaggedHandler)[BATON_WRAPPED]) return;
  const original = mutable.handler as AnyHandler;
  const wrapper = batonWrap(name, original, ctx) as TaggedHandler;
  wrapper[BATON_WRAPPED] = true;
  mutable.handler = wrapper;
}

function wireEntry(name: string, entry: unknown, ctx: WrapContext): void {
  if (name === ctx.annotationToolName) return;
  if (!entry || typeof entry !== "object") return;

  // First-time processing: inputSchema is guaranteed vendor-true (nothing
  // has injected into it yet) and the handler is guaranteed untagged, so
  // both steps always apply together here — unlike the .update() path
  // below, which must reason about which one, if either, actually needs to
  // re-run.
  captureAndInject(name, entry, ctx);
  wrapIfNeeded(name, entry, ctx);

  if (wired.has(entry)) return;
  wired.add(entry);

  const removable = entry as { remove?: unknown };
  if (typeof removable.remove === "function") {
    const originalRemove = (removable.remove as () => void).bind(entry);
    (removable as { remove: () => void }).remove = () => {
      originalRemove();
      ctx.surfaceState.pruneTool(name);
      ctx.paramRegistry.delete(name);
    };
  }

  const updatable = entry as { update?: unknown };
  if (typeof updatable.update === "function") {
    const originalUpdate = (updatable.update as (updates: unknown) => void).bind(entry);
    (updatable as { update: (updates: unknown) => void }).update = (updates: unknown) => {
      originalUpdate(updates);
      const paramsSchema = (updates as { paramsSchema?: unknown } | undefined)?.paramsSchema;
      // Only re-capture+re-inject when THIS update actually replaced
      // inputSchema (mcp.js's own `typeof updates.paramsSchema !==
      // 'undefined'` gate) — otherwise inputSchema is still Baton's prior
      // injected version, not a fresh vendor-true one (see
      // captureAndInject's docstring for why re-running on that would
      // corrupt disposition tracking).
      if (paramsSchema !== undefined) {
        captureAndInject(name, entry, ctx);
      }
      // A callback swap always needs (re-)wrapping, independent of whether
      // the schema also changed.
      wrapIfNeeded(name, entry, ctx);
    };
  }
}

/** Install Baton into an `McpServer`. See module docstring for usage. */
export function withBaton(server: McpServer, config: BatonConfig): BatonHandle {
  validateBatonConfig(config);
  const sink = config.sink ?? new StdoutSink();
  const annotationToolName = config.annotationToolName || `${config.vendorId}_annotate`;
  const intentParamMode: IntentParamMode = config.intentParamMode ?? "optional";
  const counter = new SessionCounter();
  const fallbackSessionId = `sdk-${uuidv7()}`;
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
      tenant_id: config.vendorId,
      vendor_id: config.vendorId,
      session_id: sessionId,
      consent_token: config.consentToken,
      sequence_number: counter.next(sessionId),
      captured_at: new Date().toISOString(),
      agent_runtime: config.defaultAgentRuntime ?? "unknown",
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

  const tracker = new ProactiveTracker();
  const ctx: WrapContext = {
    sink,
    counter,
    tenantId: config.vendorId,
    vendorId: config.vendorId,
    consentToken: config.consentToken,
    fallbackSessionId,
    defaultAgentRuntime: config.defaultAgentRuntime ?? "unknown",
    scrubber,
    resolveSessionId: config.resolveSessionId,
    annotationToolName,
    intentParamMode,
    paramRegistry: new Map(),
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
  (server.server as any)._instructions = instructions;

  const resolvedAnnotationToolName = registerAnnotationTool(server, {
    sink,
    counter: ctx.counter,
    tenantId: ctx.tenantId,
    vendorId: ctx.vendorId,
    vendorDisplayName: config.vendorDisplayName,
    consentToken: ctx.consentToken,
    fallbackSessionId: ctx.fallbackSessionId,
    defaultAgentRuntime: ctx.defaultAgentRuntime,
    scrubber: ctx.scrubber,
    resolveSessionId: ctx.resolveSessionId,
    annotationToolName: config.annotationToolName,
    tracker,
  });

  // Retroactive: sweep whatever's already registered, regardless of call order.
  const existing = (server as any)._registeredTools as Record<string, unknown> | undefined;
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
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: AnyArgs
  ) => RegisteredTool;
  server.registerTool = ((name: string, ...rest: AnyArgs) => {
    const registered = originalRegisterTool(name, ...rest);
    wireEntry(name, registered, ctx);
    return registered;
  }) as typeof server.registerTool;

  return new BatonHandle({
    sink,
    vendorId: config.vendorId,
    sessionId: fallbackSessionId,
    annotationToolName: resolvedAnnotationToolName,
  });
}
