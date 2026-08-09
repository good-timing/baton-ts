/**
 * Baton SDK — structured signal capture for agent-mediated tool use.
 *
 * TypeScript counterpart to `baton-sdk` (Python) — see that repo's
 * `docs/CHARTER.md` (load-bearing decisions) and `docs/SPEC.md` (the wire
 * protocol) for the canonical spec; this repo has none of its own.
 *
 * Phase 1 scaffold (this release): event types + sinks only. The MCP
 * interceptor (`withBaton`) that actually captures tool calls is Phase 2 —
 * see design-notes/typescript_sdk.md in baton-internal — not yet
 * implemented, so this package cannot instrument a server yet.
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

export type { Sink, StdoutSinkOptions, HttpSinkOptions } from "./sinks.js";
export { StdoutSink, HttpSink, safeWrite } from "./sinks.js";
