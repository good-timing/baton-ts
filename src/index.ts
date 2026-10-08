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
  // The twelve resource/prompt lifecycle types (SPEC §11.4.4). Exported for
  // the reason `f1b7ab2` exported `ResultCaptureMode`: the rolled-up
  // `dist/index.d.ts` carries them transitively, because `Event` references
  // them, but WITHOUT `export` — so a vendor could not name one and had to
  // spell `Extract<Event, {event_type: "resource_read_start"}>` instead.
  ResourceListStartEvent,
  ResourceListStartPayload,
  ResourceListEndEvent,
  ResourceListEndPayload,
  ResourceListErrorEvent,
  ResourceListErrorPayload,
  ResourceReadStartEvent,
  ResourceReadStartPayload,
  ResourceReadEndEvent,
  ResourceReadEndPayload,
  ResourceReadErrorEvent,
  ResourceReadErrorPayload,
  PromptListStartEvent,
  PromptListStartPayload,
  PromptListEndEvent,
  PromptListEndPayload,
  PromptListErrorEvent,
  PromptListErrorPayload,
  PromptGetStartEvent,
  PromptGetStartPayload,
  PromptGetEndEvent,
  PromptGetEndPayload,
  PromptGetErrorEvent,
  PromptGetErrorPayload,
  ToolListStartEvent,
  ToolListStartPayload,
  ToolListEndEvent,
  ToolListEndPayload,
  ToolListErrorEvent,
  ToolListErrorPayload,
} from "./events.js";

export { DEFAULT_CONSENT_TOKEN } from "./events.js";

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
  PrincipalWireSchema,
  ResourceListStartEventSchema,
  ResourceListStartPayloadSchema,
  ResourceListEndEventSchema,
  ResourceListEndPayloadSchema,
  ResourceListErrorEventSchema,
  ResourceListErrorPayloadSchema,
  ResourceReadStartEventSchema,
  ResourceReadStartPayloadSchema,
  ResourceReadEndEventSchema,
  ResourceReadEndPayloadSchema,
  ResourceReadErrorEventSchema,
  ResourceReadErrorPayloadSchema,
  PromptListStartEventSchema,
  PromptListStartPayloadSchema,
  PromptListEndEventSchema,
  PromptListEndPayloadSchema,
  PromptListErrorEventSchema,
  PromptListErrorPayloadSchema,
  PromptGetStartEventSchema,
  PromptGetStartPayloadSchema,
  PromptGetEndEventSchema,
  PromptGetEndPayloadSchema,
  PromptGetErrorEventSchema,
  PromptGetErrorPayloadSchema,
  ToolListStartEventSchema,
  ToolListStartPayloadSchema,
  ToolListEndEventSchema,
  ToolListEndPayloadSchema,
  ToolListErrorEventSchema,
  ToolListErrorPayloadSchema,
} from "./events.js";

export { Scrubber, identityScrub, DEPTH_LIMIT } from "./scrub.js";

export type { Sink, StdoutSinkOptions, HttpSinkOptions } from "./sinks.js";
export { StdoutSink, HttpSink, safeWrite } from "./sinks.js";

export type { BatonConfig } from "./integrations/mcp/index.js";
// `BatonConfig.resultCaptureMode` is typed with it, so a vendor cannot name
// the field's type without it.
export type { ResultCaptureMode } from "./integrations/mcp/index.js";
export { createBaton, withBaton, BatonHandle } from "./integrations/mcp/index.js";
export type { Baton } from "./integrations/mcp/index.js";
// The only way a consumer can name `withBaton`'s parameter now that neither
// SDK major's `McpServer` is imported.
export type { SupportedMcpServer } from "./integrations/mcp/index.js";

// Principal identity. `Principal`, `PrincipalForm` and
// `PrincipalResolutionContext` are what a vendor's `resolvePrincipal` hook
// signs its function against, so a vendor cannot write a typed hook without
// naming them.
export type { Principal, PrincipalForm } from "./identity.js";
// `PrincipalWire` and `principalFor` are NOT exported: they are the
// PRODUCER's, and `principalFor` is the single construction site for the wire
// object. `Event.principal` is inferred from `PrincipalWireSchema`, whose
// members are deliberately open, so a consumer wanting a name for the
// received shape uses `z.infer<typeof PrincipalWireSchema>` or
// `Event["principal"]`.
export {
  PRINCIPAL_FORM_HASHED,
  PRINCIPAL_FORM_RAW,
  PRINCIPAL_SOURCE_ASSERTED,
} from "./identity.js";
export type {
  AuthInfo,
  ResolvePrincipalHook,
  PrincipalResolutionContext,
} from "./integrations/mcp/index.js";
// The ready-made hooks — the OAuth case is common enough to ship, and a vendor
// whose verifier keeps claims elsewhere writes their own (see `oauthHooks.ts`).
export { principalFromOAuthEmail, principalFromOAuthSub } from "./integrations/mcp/index.js";
