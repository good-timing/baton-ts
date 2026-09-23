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
import type { PrincipalWire } from "./identity.js";

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

/** Emitted when the call FAILED, which MCP expresses two ways (SPEC §11.4.3):
 * the vendor handler throws, or it returns a result carrying MCP's error flag
 * on a 200. `error_type` is the error's constructor name for a throw and the
 * registered value `"tool_error"` for a returned flag; `error_body` is the
 * message or the unwrapped reason (PII-scrubbed, capped at 2000 chars per the
 * design note).
 *
 * ⚠ This schema ACCEPTS `result` but this producer does not yet EMIT it, and
 * the split is deliberate. Unlike `baton-console`'s ingest — which forbids
 * unknown keys on the envelope only, leaving `payload` an opaque dict — this
 * schema is `.strict()` down to the payload, and `test/conformance.test.ts`
 * parses every `baton-spec` vector through it. So a `baton-spec` bump carrying
 * the field reds this suite on BOTH error vectors, the throw-shape one
 * included, because it now carries `result: null`. Accepting first is what
 * makes that bump safe; emitting is the separate change.
 *
 * `result` carries the full result envelope on the returned shape and is null
 * on a throw, where no result object exists. It is deliberately NOT unwrapped
 * the way `tool_call_end.result` unwraps to the developer's return: on a
 * failure the envelope is what holds the flag and the reason. */
export const ToolCallErrorPayloadSchema = z
  .object({
    tool_name: z.string(),
    error_type: z.string(),
    error_body: z.string(),
    duration_ms: z.number().int().nullable().default(null),
    // ⚠ `.optional()`, NOT `.default(null)` like the sibling fields — and the
    // difference is the whole reason this lands as its own change.
    //
    // A default makes the schema an EMITTER: parsing a payload without the key
    // ADDS it. This repo's submodule still pins a `baton-spec` whose
    // `events.schema.json` is `additionalProperties: false`, and three tests
    // check the TS side against that pin — a byte-identical vector round-trip,
    // an ajv validation of TS-built events, and a field-for-field payload
    // comparison. All three reddened on `.default(null)`, because the schema
    // started inventing a key the pinned spec forbids.
    //
    // `.optional()` accepts the field when a newer vector carries it and stays
    // silent when it does not, so this file is correct against BOTH spec pins
    // and the bump is decoupled from it. Revisit only if this producer starts
    // emitting the field, which is a separate change.
    result: z.unknown().nullable().optional(),
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

/**
 * What the SDK puts in `consent_token` when the vendor names no other value.
 * Byte-for-byte Python's `baton.events.DEFAULT_CONSENT_TOKEN`, and the two
 * must not drift: a collector comparing the field across arms would see two
 * populations where there is one.
 *
 * **The field stays on the wire and the customer stops carrying it.** SPEC
 * §2.3 governs the envelope, not the config, so defaulting here changes
 * nothing a consumer sees — this is the value the onboarding recipe has been
 * minting into `BATON_CONSENT_TOKEN` all along, now stated once instead of
 * threaded through an environment variable that reads to nobody.
 */
export const DEFAULT_CONSENT_TOKEN = "customer-consented";

/** The principal as emitted — `{id, source, form}`, all three REQUIRED
 * together (SPEC §11.4). The runtime shape of `identity.PrincipalWire`.
 *
 * `.strict()` mirrors Python's `extra="forbid"`: a member this producer does
 * not know about is a malformed object, not a richer one.
 *
 * ⚠ **`source` and `form` are `z.string()`, not enums, on purpose** — the same
 * decision `transport_observed` records and the collector's own columns make.
 * A fourth `source` is already foreseen (alias-derived), and an enum would
 * make this producer unable to emit a value SPEC registers later without a
 * release. Worse, it would throw at the emit boundary — `emit()` catches that
 * and DROPS the event, so the tool call survives and the capture does not,
 * which is still the wrong trade for a value SPEC may register later. The
 * safety lives in the consumer rules stated positively — trust only exactly
 * `"attested"`, treat anything but exactly `"hashed"` as personal data — so an
 * unregistered value fails safe without anything having to reject it. */
export const PrincipalWireSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    form: z.string(),
  })
  .strict();

// ⚠ **The producer type and this schema are two declarations of one wire
// shape, and this is what makes them agree.** Every other wire type in this
// file is projected with `z.infer`; this one cannot be, because the producer
// side is deliberately NARROWER (literal `source`/`form`) than the parse side
// (open `z.string()`) — see `identity.PrincipalWire`.
//
// Without the check below the drift is silent in the worst direction: add a
// member to `PrincipalWire`, and `principalFor` compiles green while
// `.strict()` rejects the object at the emit boundary, where `emit()` catches
// the throw and DROPS the event. Capture loss with no error at the site of
// the change. Asserting the KEY SETS match both ways turns that into a
// compile error here.
type _PrincipalKeysMatch =
  [Exclude<keyof PrincipalWire, keyof z.infer<typeof PrincipalWireSchema>>] extends [never]
    ? [Exclude<keyof z.infer<typeof PrincipalWireSchema>, keyof PrincipalWire>] extends [never]
      ? true
      : never
    : never;
const _principalKeysMatch: _PrincipalKeysMatch = true;
void _principalKeysMatch;

/** Fields every Baton event carries, per SPEC §11.4.
 *
 * `consentToken` is REQUIRED — the Console rejects any event missing it.
 * `vendorId` is REQUIRED — the wrapped vendor identifier; the Console groups
 * friction by `(tenant_id, vendor_id)`.
 * `principal` is the resolved principal as emitted — `{id, source, form}`, all
 * three required together, hashed at the capture edge in the default mode so
 * the raw principal never leaves it; null when nobody was resolved.
 * `runtimeMeta` is the runtime-supplied MCP request `_meta` envelope, used
 * by the Console to derive turn/cycle boundaries more precise than
 * `session_id` alone.
 *
 * `call_id` is the minted per-call correlation key: the SAME value on a tool
 * call's `tool_call_start` and its `tool_call_end` / `tool_call_error`, so a
 * worker pairs the two legs on an identifier this producer controls rather
 * than inferring the pairing from session + arrival order. Consumers key
 * SPEC §11.5.4's tier 1 on `(call_id, tool_name)`, not on the id alone —
 * which is why a TS server without it is unreachable from that tier and
 * falls back to the FIFO floor the mint exists to leave.
 *
 * It is an ENVELOPE field, present on all five event types, and null on
 * `annotation` and `surface_snapshot` — SPEC defines a `call_id` for a tool
 * call's legs and putting one on the other two would invent semantics no
 * spec text defines. Null is never an error; it is also what every event
 * emitted before this field existed carries.
 *
 * Minted as a bare opaque UUIDv7 in a local inside the scope that emits both
 * legs — per-call by construction and correct across processes. Never
 * derived from the JSON-RPC request id, which restarts at 1 per connection.
 * It says WHICH CALL, never WHO; the principal is `principal.id`. */
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
  principal: PrincipalWireSchema.nullable().default(null),
  transport_observed: z.string().nullable().default(null),
  call_id: z.string().nullable().default(null),
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
