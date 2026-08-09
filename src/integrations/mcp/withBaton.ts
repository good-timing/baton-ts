/**
 * `withBaton` — the vendor's MCP integration entry point for the official
 * `@modelcontextprotocol/sdk`'s high-level `McpServer`.
 *
 * ```typescript
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { withBaton } from "@baton/sdk";
 *
 * const server = new McpServer({ name: "your-vendor-mcp", version: "1.0.0" });
 * const handle = withBaton(server, { vendorId: "your-vendor", consentToken: "..." });
 * ```
 *
 * Capture-only (Phase 2 of design-notes/typescript_sdk.md, baton-internal):
 * wraps every tool handler to emit `tool_call_start` → call →
 * `tool_call_end` / `tool_call_error`. No annotation tool, no `instructions`
 * injection, no intent-param injection, no `surface_snapshot` — see
 * CHANGELOG.md for why those are a matched pair gated together, not simply
 * unbuilt.
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
 * tools registered on the other side of the ordering.
 */

import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { v7 as uuidv7 } from "uuid";
import {
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  ToolCallStartEventSchema,
  type Event,
} from "../../events.js";
import { safeWrite, StdoutSink, type Sink } from "../../sinks.js";
import { validateBatonConfig, identityScrub, type BatonConfig } from "./config.js";
import { BatonHandle } from "./handle.js";
import { detectAgentRuntime } from "./runtimeAdapter.js";
import { SessionCounter } from "./sessionCounter.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
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
}

// `_registeredTools` and `RegisteredTool.handler` are internal to
// @modelcontextprotocol/sdk, not part of its public .d.ts surface. Reaching
// into them is deliberate (see module docstring) and requires stepping
// outside the type system the same way Python's _registry.py does —
// isolated to this one module so a future SDK internals change has exactly
// one place to update.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

const wrapped = new WeakSet<object>();

async function emit(sink: Sink, build: () => Event): Promise<void> {
  let event: Event;
  try {
    event = build();
  } catch (err) {
    // Event construction (Zod validation) failing must not break the
    // vendor's tool call any more than a sink failure would — SPEC §11.2
    // fail-open applies to the whole capture step, not just the write.
    process.stderr.write(`baton: event construction failed; event dropped: ${String(err)}\n`);
    return;
  }
  await safeWrite(sink, event);
}

async function resolveSessionId(
  ctx: WrapContext,
  extra: Extra,
  meta: Record<string, unknown> | null,
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  if (ctx.resolveSessionId) {
    try {
      const hookResult = await ctx.resolveSessionId({ meta, toolName, arguments: params });
      if (typeof hookResult === "string" && hookResult) return hookResult;
    } catch {
      // Never propagate a hook failure — fall through to the ladder below,
      // mirroring Python's resolve_via_hook.
    }
  }
  if (typeof extra.sessionId === "string" && extra.sessionId) return extra.sessionId;
  return ctx.fallbackSessionId;
}

function batonWrap(toolName: string, original: AnyHandler, ctx: WrapContext): AnyHandler {
  return async (...callArgs: AnyArgs): Promise<unknown> => {
    const extra = callArgs[callArgs.length - 1] as Extra;
    const params = (callArgs.length > 1 ? callArgs[0] : {}) as Record<string, unknown>;
    const meta = (extra._meta as Record<string, unknown> | undefined) ?? null;
    const runtime = detectAgentRuntime(meta) ?? ctx.defaultAgentRuntime;
    const scrubbedMeta = meta ? (ctx.scrubber(meta) as Record<string, unknown>) : null;
    const sessionId = await resolveSessionId(ctx, extra, meta, toolName, params);

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
  };

  const existing = (server as any)._registeredTools as Record<string, unknown> | undefined;
  if (existing) {
    for (const [name, entry] of Object.entries(existing)) {
      wrapEntry(name, entry, ctx);
    }
  }

  const originalRegisterTool = server.registerTool.bind(server) as (...args: AnyArgs) => RegisteredTool;
  server.registerTool = ((name: string, ...rest: AnyArgs) => {
    const registered = originalRegisterTool(name, ...rest);
    wrapEntry(name, registered, ctx);
    return registered;
  }) as typeof server.registerTool;

  return new BatonHandle({ sink, vendorId: config.vendorId, sessionId: ctx.fallbackSessionId });
}
