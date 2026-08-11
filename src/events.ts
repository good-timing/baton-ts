/**
 * Zod schemas + TS types for the Baton event stream per SPEC §11.4.
 *
 * This is a hand-maintained mirror of `baton-spec/events.schema.json`, which
 * is itself exported from `baton-sdk` (Python)'s Pydantic models — that repo
 * is the schema of record. `test/conformance.test.ts` validates every
 * concrete type below against `baton-spec/events.schema.json` with ajv and
 * against `baton-spec/vectors/*.json`, so a drift here fails CI rather than
 * surfacing as a silent Console-side shape mismatch.
 *
 * All concrete event schemas share the same envelope fields and differ only
 * in `payload`. Fields match Python field-for-field (snake_case on the wire,
 * per CHARTER's wire-compatibility requirement — NOT camelCase).
 */

import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { SDK_VERSION } from "./version.js";

// =============================================================================
// Per-event-type payloads
// =============================================================================

/** Emitted before the vendor handler runs. `params` is PII-scrubbed at
 * emit-time per SPEC §7.
 *
 * `call_intent` / `call_expected` / `call_workflow` are the values the SDK
 * stripped from the injected `user_goal` / `expected_result` /
 * `overall_task` params (see `llmText.ts`); they ride as SIBLINGS of
 * `params` — `params` stays exactly the vendor-visible arguments.
 * `call_intent`/`call_expected` are call-scoped diagnostics;
 * `call_workflow` is the task-label grouping key (console rung 3b, exact
 * string continuity). `intent_source` records provenance
 * (`"injected_param"`). All null when the params weren't used. */
export const ToolCallStartPayloadSchema = z
  .object({
    tool_name: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
    call_intent: z.string().nullable().default(null),
    call_expected: z.string().nullable().default(null),
    call_workflow: z.string().nullable().default(null),
    intent_source: z.string().nullable().default(null),
  })
  .strict();
export type ToolCallStartPayload = z.infer<typeof ToolCallStartPayloadSchema>;

/** Emitted after the vendor handler returns. `result` is PII-scrubbed. */
export const ToolCallEndPayloadSchema = z
  .object({
    tool_name: z.string(),
    result: z.unknown().nullable().default(null),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type ToolCallEndPayload = z.infer<typeof ToolCallEndPayloadSchema>;

/** Emitted when the vendor handler throws. `error_type` is the error's
 * constructor name; `error_body` is the message (PII-scrubbed, capped at
 * 2000 chars per the design note). */
export const ToolCallErrorPayloadSchema = z
  .object({
    tool_name: z.string(),
    error_type: z.string(),
    error_body: z.string(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type ToolCallErrorPayload = z.infer<typeof ToolCallErrorPayloadSchema>;

/** Agent-supplied context. All fields nullable per SPEC §5.1.1 — the agent
 * populates what it has. Proactive annotations typically populate
 * `intent`/`expected_outcome`/`workflow`; reactive annotations typically
 * populate `signal_type`/`suggested_improvement`. */
export const AnnotationPayloadSchema = z
  .object({
    intent: z.string().nullable().default(null),
    expected_outcome: z.string().nullable().default(null),
    signal_type: z.string().nullable().default(null),
    workflow: z.string().nullable().default(null),
    suggested_improvement: z.string().nullable().default(null),
    context: z.record(z.string(), z.unknown()).nullable().default(null),
    intent_source: z.string().nullable().default(null),
    tool_name: z.string().nullable().default(null),
  })
  .strict();
export type AnnotationPayload = z.infer<typeof AnnotationPayloadSchema>;

/** The vendor-true upstream surface (pre-injection) — mirrors baton-proxy's
 * `enqueue_surface_snapshot` payload so the Console worker materializes both
 * into the same `vendor_surfaces` table. Emitted at most once per observed
 * `surface_hash` per process. `tools` excludes Baton's own injected tool(s);
 * those live in `seam_augmentations.injected_tools` instead. */
export const SurfaceSnapshotPayloadSchema = z
  .object({
    surface_hash: z.string(),
    server_info: z.record(z.string(), z.unknown()).nullable().default(null),
    capabilities: z.record(z.string(), z.unknown()).nullable().default(null),
    instructions: z.string().nullable().default(null),
    tools: z.array(z.record(z.string(), z.unknown())).default([]),
    seam_augmentations: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type SurfaceSnapshotPayload = z.infer<typeof SurfaceSnapshotPayloadSchema>;

// =============================================================================
// Envelope shared by all event types
// =============================================================================

/** Fields every Baton event carries, per SPEC §11.4.
 *
 * `consentToken` is REQUIRED — the Console rejects any event missing it.
 * `vendorId` is REQUIRED — the wrapped vendor identifier; the Console groups
 * friction by `(tenant_id, vendor_id)`.
 * `userId` is the hashed end-user actor (HMAC-SHA256, hashed at the capture
 * edge — the raw principal is never transmitted); null when unresolved.
 * `runtimeMeta` is the runtime-supplied MCP request `_meta` envelope, used
 * by the Console to derive turn/cycle boundaries more precise than
 * `session_id` alone. */
const envelopeShape = {
  event_id: z.uuid().default(() => uuidv7()),
  tenant_id: z.string(),
  vendor_id: z.string(),
  session_id: z.string(),
  sequence_number: z.number().int().nonnegative(),
  captured_at: z.string(),
  consent_token: z.string(),
  sdk_version: z.string().default(SDK_VERSION),
  agent_runtime: z.string().default("unknown"),
  user_id: z.string().nullable().default(null),
  runtime_meta: z.record(z.string(), z.unknown()).nullable().default(null),
};

export const EventTypeSchema = z.enum([
  "tool_call_start",
  "tool_call_end",
  "tool_call_error",
  "annotation",
  "surface_snapshot",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

// =============================================================================
// Concrete event schemas
// =============================================================================

export const ToolCallStartEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("tool_call_start").default("tool_call_start"),
    payload: ToolCallStartPayloadSchema,
  })
  .strict();
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;

export const ToolCallEndEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("tool_call_end").default("tool_call_end"),
    payload: ToolCallEndPayloadSchema,
  })
  .strict();
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEventSchema>;

export const ToolCallErrorEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("tool_call_error").default("tool_call_error"),
    payload: ToolCallErrorPayloadSchema,
  })
  .strict();
export type ToolCallErrorEvent = z.infer<typeof ToolCallErrorEventSchema>;

export const AnnotationEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("annotation").default("annotation"),
    payload: AnnotationPayloadSchema,
  })
  .strict();
export type AnnotationEvent = z.infer<typeof AnnotationEventSchema>;

export const SurfaceSnapshotEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("surface_snapshot").default("surface_snapshot"),
    payload: SurfaceSnapshotPayloadSchema,
  })
  .strict();
export type SurfaceSnapshotEvent = z.infer<typeof SurfaceSnapshotEventSchema>;

// =============================================================================
// Discriminated union — mirrors Python's `Event` (discriminator: event_type)
// =============================================================================

export const EventSchema = z.discriminatedUnion("event_type", [
  ToolCallStartEventSchema,
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  AnnotationEventSchema,
  SurfaceSnapshotEventSchema,
]);
export type Event =
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ToolCallErrorEvent
  | AnnotationEvent
  | SurfaceSnapshotEvent;
