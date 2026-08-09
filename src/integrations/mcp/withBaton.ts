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
 * `tool_call_error`, injects server `instructions` (SPEC §5.1.2), and
 * registers the `<vendor>_annotate` tool (SPEC §5.1.1). No intent-param
 * injection, no `surface_snapshot` — see README "What's deferred".
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
 *    single swap point for an upstream rename, not an accident).
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
 * Instructions injection reaches into `server.server`'s private
 * `_instructions` field — unlike Python's FastMCP (a read-only property
 * with a private-attribute fallback), the official TS SDK's `Server` has no
 * settable `instructions` at all post-construction, so there's no
 * "preferred" public path to fall back from here.
 */

import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { v7 as uuidv7 } from "uuid";
import { ToolCallEndEventSchema, ToolCallErrorEventSchema, ToolCallStartEventSchema } from "../../events.js";
import { StdoutSink, type Sink } from "../../sinks.js";
import { registerAnnotationTool } from "./annotation.js";
import { validateBatonConfig, identityScrub, type BatonConfig } from "./config.js";
import { emit } from "./emit.js";
import { BatonHandle } from "./handle.js";
import { buildServerInstructions } from "./llmText.js";
import type { Extra } from "./mcpTypes.js";
import { detectAgentRuntime } from "./runtimeAdapter.js";
import { resolveSessionId } from "./sessionResolution.js";
import { SessionCounter } from "./sessionCounter.js";

type AnyArgs = unknown[];
type AnyHandler = (...args: AnyArgs) => unknown;

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
}

// `_registeredTools`, `RegisteredTool.handler`, and `server.server._instructions`
// are internal to @modelcontextprotocol/sdk, not part of its public .d.ts
// surface. Reaching into them is deliberate (see module docstring) and
// requires stepping outside the type system the same way Python's
// _registry.py does — isolated to this one module so a future SDK
// internals change has exactly one place to update.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

const wrapped = new WeakSet<object>();

function batonWrap(toolName: string, original: AnyHandler, ctx: WrapContext): AnyHandler {
  return async (...callArgs: AnyArgs): Promise<unknown> => {
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

    const common = {
      tenant_id: ctx.tenantId,
      vendor_id: ctx.vendorId,
      session_id: sessionId,
      consent_token: ctx.consentToken,
      agent_runtime: runtime,
      runtime_meta: scrubbedMeta,
    };

    await emit(ctx.sink, () =>
      ToolCallStartEventSchema.parse({
        ...common,
        sequence_number: ctx.counter.next(sessionId),
        captured_at: new Date().toISOString(),
        payload: { tool_name: toolName, params: ctx.scrubber(params) },
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

function wrapEntry(name: string, entry: unknown, ctx: WrapContext): void {
  // The annotation tool emits its own `annotation` event from inside
  // registerAnnotationTool — wrapping it here too would double-emit a
  // tool_call_start/end around every annotate call, matching Python's
  // `if tool_name == self._annotation_tool_name: return await call_next(...)` skip.
  if (name === ctx.annotationToolName) return;
  if (!entry || typeof entry !== "object") return;
  if (wrapped.has(entry)) return;
  const mutable = entry as { handler: unknown };
  // Task-based tools (experimental) carry an object, not a function, at
  // .handler — see module docstring. Leave them untouched rather than
  // guess at wrapping a shape we don't capture events for yet.
  if (typeof mutable.handler !== "function") return;
  const original = mutable.handler as AnyHandler;
  mutable.handler = batonWrap(name, original, ctx);
  wrapped.add(entry);
}

/** Install Baton into an `McpServer`. See module docstring for usage. */
export function withBaton(server: McpServer, config: BatonConfig): BatonHandle {
  validateBatonConfig(config);
  const sink = config.sink ?? new StdoutSink();
  const annotationToolName = config.annotationToolName || `${config.vendorId}_annotate`;
  const ctx: WrapContext = {
    sink,
    counter: new SessionCounter(),
    tenantId: config.vendorId,
    vendorId: config.vendorId,
    consentToken: config.consentToken,
    fallbackSessionId: `sdk-${uuidv7()}`,
    defaultAgentRuntime: config.defaultAgentRuntime ?? "unknown",
    scrubber: config.scrubber ?? identityScrub,
    resolveSessionId: config.resolveSessionId,
    annotationToolName,
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
  });

  // Retroactive: sweep whatever's already registered, regardless of call order.
  const existing = (server as any)._registeredTools as Record<string, unknown> | undefined;
  if (existing) {
    for (const [name, entry] of Object.entries(existing)) {
      wrapEntry(name, entry, ctx);
    }
  }

  // Prospective: every future registration goes through here too. Patched
  // AFTER registerAnnotationTool runs above (deliberately) — the annotate
  // tool registration hits the original, unpatched registerTool, lands in
  // _registeredTools, and gets excluded by name in the retroactive sweep
  // just above instead. Patching registerTool before registering the
  // annotate tool would work too (wrapEntry's name check guards either
  // order), but this ordering means the annotate tool only ever needs to
  // be excluded in the one place, not reasoned about twice.
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: AnyArgs
  ) => RegisteredTool;
  server.registerTool = ((name: string, ...rest: AnyArgs) => {
    const registered = originalRegisterTool(name, ...rest);
    wrapEntry(name, registered, ctx);
    return registered;
  }) as typeof server.registerTool;

  return new BatonHandle({
    sink,
    vendorId: config.vendorId,
    sessionId: ctx.fallbackSessionId,
    annotationToolName: resolvedAnnotationToolName,
  });
}
