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
} from "./events.js";

export { Scrubber, identityScrub, DEPTH_LIMIT } from "./scrub.js";

export type { Sink, StdoutSinkOptions, HttpSinkOptions } from "./sinks.js";
export { StdoutSink, HttpSink, safeWrite } from "./sinks.js";

export type { BatonConfig } from "./integrations/mcp/index.js";
// Exported for the reason `PrincipalIdMode` is, below: `BatonConfig
// .resultCaptureMode` is typed with it, so a vendor cannot name the field's
// type without it.
export type { ResultCaptureMode } from "./integrations/mcp/index.js";
export { withBaton, BatonHandle } from "./integrations/mcp/index.js";
// The only way a consumer can name `withBaton`'s parameter now that neither
// SDK major's `McpServer` is imported.
export type { SupportedMcpServer } from "./integrations/mcp/index.js";

// Principal identity. `Principal` and `PrincipalResolutionContext` are what a
// vendor's `resolvePrincipal` hook signs its function against, so they are part of
// the public contract the moment the hook is — a vendor cannot write a typed
// hook without naming them. `hashPrincipalId` is exported for the same reason
// `Scrubber` is: a vendor recomputing a pseudonym outside the SDK (to join
// their own records against Console data) must get the identical value, and
// re-implementing the HMAC message layout by hand is how that silently
// diverges.
export type { Principal, PrincipalIdMode } from "./identity.js";
// ⚠ `PrincipalWire` and `PrincipalForm` are NOT exported, for the same reason
// `principalFor` is not: they are the PRODUCER's types, narrowed to the one
// `source` and two `form`s this SDK emits. Nothing on the public surface can
// produce one — `Event.principal` is inferred from `PrincipalWireSchema`,
// whose members are deliberately open, so `event.principal` does not satisfy
// the narrow type and a vendor naming it in a `Sink` signature gets TS2345.
// A consumer wanting a name for the received shape uses
// `z.infer<typeof PrincipalWireSchema>` or `Event["principal"]`.
// ⚠ **`HASH_SCHEME` was exported here until 0.4.1 and is GONE**, because there
// is no prefix left for a vendor recomputing a pseudonym to match: a hashed
// principal is the bare digest (SPEC §11.4, §13 entry 0.8.11). A vendor holding
// the old constant gets a tagged value from its own copy and a bare one from
// this SDK across the upgrade — a breaking removal, stated in the CHANGELOG.
//
// `principalFor` is NOT exported, and that is the deliberate half: it is the
// single construction site for the wire object, and handing it out invites a
// vendor to assemble a `principal` by hand, which is exactly the "all three
// members or nothing" guarantee this change exists to make structural.
export {
  PRINCIPAL_FORM_HASHED,
  PRINCIPAL_FORM_RAW,
  PRINCIPAL_SOURCE_ASSERTED,
  hashPrincipalId,
} from "./identity.js";
export type {
  AuthInfo,
  ResolvePrincipalHook,
  PrincipalResolutionContext,
} from "./integrations/mcp/index.js";
// The ready-made hooks — the OAuth case is common enough to ship, and a vendor
// whose verifier keeps claims elsewhere writes their own (see `oauthHooks.ts`).
export { principalFromOAuthEmail, principalFromOAuthSub } from "./integrations/mcp/index.js";
