/**
 * Baton SDK — structured signal capture for agent-mediated tool use.
 *
 * TypeScript counterpart to `baton-sdk` (Python) — see that repo's
 * `docs/CHARTER.md` (load-bearing decisions) and `docs/SPEC.md` (the wire
 * protocol) for the canonical spec; this repo has none of its own.
 *
 * `withBaton(server, config)` is the entry point: it instruments a high-level
 * `McpServer` in one call — wrapping tool calls,
 * injecting server instructions and intent params, registering the
 * `<vendor>_annotate` tool, and capturing a `surface_snapshot`. Payloads are
 * PII-scrubbed by the default ruleset before they reach any sink; pass
 * `identityScrub` to opt out.
 *
 * Both majors of the official SDK are supported — 1.x
 * (`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/server`) — and
 * both are OPTIONAL peerDependencies: install whichever your server is built
 * on. Nothing here imports either package, at runtime or as a type, so the
 * one you do not have is never resolved. `withBaton` takes the structural
 * `SupportedMcpServer` that both classes satisfy.
 *
 * Pre-1.0 — public API not yet stable.
 */

export { SDK_VERSION } from "./version.js";

export type {
  Event,
  EventType,
  ToolCallStartEvent,
  ToolCallStartPayload,
  ToolCallEndEvent,
  ToolCallEndPayload,
  ToolCallErrorEvent,
  ToolCallErrorPayload,
  AnnotationEvent,
  AnnotationPayload,
  SurfaceSnapshotEvent,
  SurfaceSnapshotPayload,
} from "./events.js";

export {
  EventSchema,
  EventTypeSchema,
  ToolCallStartEventSchema,
  ToolCallStartPayloadSchema,
  ToolCallEndEventSchema,
  ToolCallEndPayloadSchema,
  ToolCallErrorEventSchema,
  ToolCallErrorPayloadSchema,
  AnnotationEventSchema,
  AnnotationPayloadSchema,
  SurfaceSnapshotEventSchema,
  SurfaceSnapshotPayloadSchema,
} from "./events.js";

export { Scrubber, identityScrub, DEPTH_LIMIT } from "./scrub.js";

export type { Sink, StdoutSinkOptions, HttpSinkOptions } from "./sinks.js";
export { StdoutSink, HttpSink, safeWrite } from "./sinks.js";

export type {
  BatonConfig,
  ResolveSessionIdHook,
  SessionResolutionContext,
} from "./integrations/mcp/index.js";
export { withBaton, BatonHandle } from "./integrations/mcp/index.js";
// The only way a consumer can name `withBaton`'s parameter now that neither
// SDK major's `McpServer` is imported.
export type { SupportedMcpServer } from "./integrations/mcp/index.js";
