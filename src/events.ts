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
    // SPEC §11.4: the producer declares it WITHHELD result-derived data.
    // Absent means CAPTURED, so no consumer needs a version table.
    //
    // `.optional()`, NOT `.default(null)`, for the reason recorded on
    // `ToolCallErrorPayloadSchema.result` below: a default makes this reader
    // an EMITTER, and parsing a stored event from before the member existed
    // would hand back an invented key.
    //
    // ⚠ **This package OMITS the member when capturing, where the Python SDK
    // sends `result_capture: null`.** Both are conformant and SPEC §11.4 says
    // so outright — absent and null are equivalent, and a consumer MUST read
    // the VALUE, never test for the key. It is the same axis `result` already
    // differs on between `baton-sdk` (null) and `baton-proxy` (omitted), per
    // §11.4.3. Omitting is chosen here because the alternative — matching
    // Python — would require regenerating `baton-spec`'s vectors from an
    // UNMERGED branch, pinning a key set no released producer emits.
    result_capture: z.string().nullable().optional(),
  })
  .strict();
export type ToolCallEndPayload = z.infer<typeof ToolCallEndPayloadSchema>;

/** Emitted when the call FAILED, which MCP expresses two ways (SPEC §11.4.3):
 * the vendor handler throws, or it returns a result carrying MCP's error flag
 * on a 200. `error_type` is the error's constructor name for a throw and the
 * registered value `"tool_error"` for a returned flag; `error_body` is the
 * message or the unwrapped reason (PII-scrubbed, then capped — the limit and
 * its unit live on `ERROR_BODY_MAX_CODE_POINTS` in
 * `integrations/mcp/errorResult.ts`, which both failure legs cut with).
 *
 * ⚠ This schema ACCEPTED `result` one commit before this producer emitted
 * it (`67453eb`), and the split was deliberate. Unlike `baton-console`'s
 * ingest — which forbids unknown keys on the envelope only, leaving `payload`
 * an opaque dict — this schema is `.strict()` down to the payload, and
 * `test/conformance.test.ts` parses every `baton-spec` vector through it. So
 * the `baton-spec` bump carrying the field would have reddened this suite on
 * BOTH error vectors, the throw-shape one included, because it now carries
 * `result: null`. Accepting first is what made that bump safe.
 *
 * `result` carries the full result envelope on the returned shape and is null
 * on a throw, where no result object exists.
 *
 * ⚠ **THE shape claim for this field lives here; everywhere else points at
 * this paragraph.** On THIS producer `tool_call_error.result` and
 * `tool_call_end.result` are the SAME shape — the object the vendor's handler
 * returned, `{content, isError?}`, which neither major converts. The sentence
 * that stood here said `result` is "deliberately NOT unwrapped the way
 * `tool_call_end.result` unwraps to the developer's return"; that is Python's
 * contrast, carried over with the rest of the port, and it is FALSE here.
 * SPEC §11.4.3's requirement still binds — whatever is recorded must keep the
 * flag and the reason, which the literal does — but a consumer must not read
 * a TS-sourced `tool_call_end.result` as the bare content array Python's
 * vector shows.
 *
 * Enforced by `emitterConformance.test.ts`'s
 * `PAYLOAD_ALLOWED_TO_DIFFER["tool_call_error.returned"]` and the two shape
 * assertions beside it: the claim stops being true the day that test reds. */
export const ToolCallErrorPayloadSchema = z
  .object({
    tool_name: z.string(),
    error_type: z.string(),
    error_body: z.string(),
    duration_ms: z.number().int().nullable().default(null),
    // ⚠ `.optional()`, NOT `.default(null)` like the sibling fields — and it
    // stays that way now that the producer emits the field.
    //
    // A default makes the schema an EMITTER: parsing a payload without the key
    // ADDS it. That is wrong in a schema that also READS — a stored event from
    // before the field existed would come back carrying an invented key, and
    // against the pre-`f1e0280` spec pin, whose `events.schema.json` is
    // `additionalProperties: false`, it reddened three tests saying so: a
    // byte-identical vector round-trip, an ajv validation of TS-built events,
    // and a field-for-field payload comparison.
    //
    // `.optional()` accepts the field when a vector carries it and stays
    // silent when it does not. What makes the EMITTED shape complete is the
    // emitter declaring `result` on both failure legs (`withBaton.ts`),
    // explicitly `null` on a throw — not the schema filling it in.
    result: z.unknown().nullable().optional(),
    // SPEC §11.4, on BOTH payloads because the RETURN failure shape withholds
    // `result` too. Same `.optional()` reasoning as the field above it, and
    // same omit-when-capturing posture as `ToolCallEndPayloadSchema`.
    result_capture: z.string().nullable().optional(),
    // SPEC §11.4.3: the producer NAMES a failure it made above the vendor's
    // handler. `tool_call_error` ONLY — unlike `result_capture`, which rides
    // both payloads — because the one case that files `tool_call_end` today
    // IS the false success this member exists to correct, so after the fix
    // nothing carries it on a success payload.
    //
    // A plain `z.string()` and NOT `z.enum(FAILURE_KINDS)`, which SPEC
    // requires rather than permits: a closed enum turns a later registered
    // value into a `ValidationError` on the vendor's tool-call path, which
    // §11.2 says must fail open. The registry in
    // `integrations/mcp/errorResult.ts` constrains what this producer EMITS;
    // it must not constrain what this schema READS.
    //
    // Same `.optional()`-not-`.default(null)` reasoning as the two fields
    // above: a default makes the schema an emitter, and parsing a stored
    // event from before the member existed would hand back an invented key.
    failure_kind: z.string().nullable().optional(),
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
  // The RESOURCE and PROMPT lifecycles (SPEC §11.4.4). Twelve types whose
  // shapes were set by `baton-proxy`, which has been emitting all of them in
  // production — see the payload schemas below.
  "resource_list_start",
  "resource_list_end",
  "resource_list_error",
  "resource_read_start",
  "resource_read_end",
  "resource_read_error",
  "prompt_list_start",
  "prompt_list_end",
  "prompt_list_error",
  "prompt_get_start",
  "prompt_get_end",
  "prompt_get_error",
]);
export type EventType = z.infer<typeof EventTypeSchema>;


// =============================================================================
// Resource and prompt lifecycle payloads (SPEC §11.4.4)
// =============================================================================
//
// ⚠ **Transcribed from `baton_proxy.emitter`, field for field, because that
// producer SHIPPED FIRST.** All twelve types have been reaching the Console in
// production — whose ingest `EventType` lists every one of them — and until
// the `baton-spec` bump that accompanies this file they had no schema anywhere.
// So these do not design a shape, they RECORD one, and where the proxy's
// choices look inconsistent the inconsistency is preserved and annotated: a
// second producer must copy the shape rather than infer a rule from half of it.
//
// ⚠ **No `result_capture` on any of the twelve, and SPEC §11.4.4 makes that
// normative rather than incidental.** None of these payloads carries a body —
// a read records its URI and its timing, a list records a count — so there is
// nothing for `"off"` to withhold. The `*_start` payloads DO carry caller data
// in `params`, which is scrubbed like any other payload; §11.4 says outright
// that the member is not a statement about request data.
//
// ⚠ **No `result` and no `failure_kind` on the six error payloads.** The error
// flag is a TOOL concept: a failing resource read comes back as a JSON-RPC
// error, so these carry only §11.4.3's RAISE analogue and that subsection's
// RETURN discriminator has no counterpart here.

/** `resources/list` reached the server. Deliberately EMPTY — a list request
 * has no subject, and the envelope already names the session, the tenant and
 * the vendor. `.strict()` with no members is the claim, not an oversight. */
export const ResourceListStartPayloadSchema = z.object({}).strict();
export type ResourceListStartPayload = z.infer<typeof ResourceListStartPayloadSchema>;

/** `resources/list` returned.
 *
 * ⚠ `count` counts the `resources` array ALONE. Resource TEMPLATES are a
 * separate MCP method with their own result array and are not added in, so a
 * template-only server reports `0` — correctly — and a consumer MUST NOT read
 * that as "this server has no resources". */
export const ResourceListEndPayloadSchema = z
  .object({
    count: z.number().int(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type ResourceListEndPayload = z.infer<typeof ResourceListEndPayloadSchema>;

/** `resources/list` failed. See `ResourceReadErrorPayloadSchema` for how
 * `error_type` is spelled across producers and why `error_body` is kept. */
export const ResourceListErrorPayloadSchema = z
  .object({
    error_type: z.string(),
    error_body: z.string(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type ResourceListErrorPayload = z.infer<typeof ResourceListErrorPayloadSchema>;

/** `resources/read` reached the server.
 *
 * ⚠ **`uri` is ALSO inside `params`.** The proxy builds `params` by removing
 * `_meta` from the request's params and nothing else, and `uri` is one of
 * them — so the subject appears twice. Recorded rather than deduplicated: the
 * dedicated member is what a consumer reads, the bag is what the caller
 * actually sent, and a producer that stripped `uri` out of it would stop being
 * able to say that. */
export const ResourceReadStartPayloadSchema = z
  .object({
    uri: z.string(),
    /** The caller's own request params, PII-scrubbed (SPEC §7). Null where the
     * request carried nothing but `_meta`. */
    params: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();
export type ResourceReadStartPayload = z.infer<typeof ResourceReadStartPayloadSchema>;

/** `resources/read` returned.
 *
 * ⚠ **No content member, and that is the design.** The resource BODY is
 * customer data of exactly the kind the response-capture switch exists to keep
 * off the wire, and the only producer there was never sent it. URI plus timing
 * is what makes a failing or slow read visible without it. */
export const ResourceReadEndPayloadSchema = z
  .object({
    uri: z.string(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type ResourceReadEndPayload = z.infer<typeof ResourceReadEndPayloadSchema>;

/** `resources/read` failed.
 *
 * ⚠ **`error_type` is an unconstrained string and the producers do NOT agree
 * on how to spell it** — stated here for all six error payloads.
 * `baton-proxy` reads the WIRE, so it holds the upstream's JSON-RPC error and
 * files the numeric `code` as a string; this package holds a live exception
 * and files its class name, the way §11.4.3's RAISE shape already does for
 * tools. Both conform — §11.4.3 says this member separates SHAPES and is not a
 * closed set of values — and a consumer MUST NOT read one producer's spelling
 * as the vocabulary.
 *
 * ⚠ **`error_body` is KEPT under every capture mode.** It is a failed FETCH's
 * message, not anything a resource returned, so nothing here is
 * result-derived. */
export const ResourceReadErrorPayloadSchema = z
  .object({
    uri: z.string(),
    error_type: z.string(),
    error_body: z.string(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type ResourceReadErrorPayload = z.infer<typeof ResourceReadErrorPayloadSchema>;

/** `prompts/list` reached the server. Empty, for the reason
 * `ResourceListStartPayloadSchema` carries. */
export const PromptListStartPayloadSchema = z.object({}).strict();
export type PromptListStartPayload = z.infer<typeof PromptListStartPayloadSchema>;

/** `prompts/list` returned. `count` counts the `prompts` array. */
export const PromptListEndPayloadSchema = z
  .object({
    count: z.number().int(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type PromptListEndPayload = z.infer<typeof PromptListEndPayloadSchema>;

/** `prompts/list` failed. See `ResourceReadErrorPayloadSchema`. */
export const PromptListErrorPayloadSchema = z
  .object({
    error_type: z.string(),
    error_body: z.string(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type PromptListErrorPayload = z.infer<typeof PromptListErrorPayloadSchema>;

/** `prompts/get` reached the server.
 *
 * ⚠ **`params` is the request's `arguments` member ALONE, not the whole params
 * bag** — the opposite of `ResourceReadStartPayloadSchema`'s choice, measured
 * in the proxy. The two are inconsistent in the only producer that existed;
 * the inconsistency is recorded so a reader does not expect `name` inside
 * `params` the way `uri` does appear there. */
export const PromptGetStartPayloadSchema = z
  .object({
    name: z.string(),
    /** The prompt's arguments, PII-scrubbed (SPEC §7). Null where the request
     * supplied none. */
    params: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();
export type PromptGetStartPayload = z.infer<typeof PromptGetStartPayloadSchema>;

/** `prompts/get` returned.
 *
 * ⚠ **No rendered messages.** A prompt's text is authored by the SERVER rather
 * than fetched by a tool, so whether it is customer content at all is a
 * decision nobody has taken — and the standing answer, from the only producer,
 * is that it does not egress. */
export const PromptGetEndPayloadSchema = z
  .object({
    name: z.string(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type PromptGetEndPayload = z.infer<typeof PromptGetEndPayloadSchema>;

/** `prompts/get` failed. See `ResourceReadErrorPayloadSchema`. */
export const PromptGetErrorPayloadSchema = z
  .object({
    name: z.string(),
    error_type: z.string(),
    error_body: z.string(),
    duration_ms: z.number().int().nullable().default(null),
  })
  .strict();
export type PromptGetErrorPayload = z.infer<typeof PromptGetErrorPayloadSchema>;

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

// ⚠ The twelve lifecycle events carry the SAME `envelopeShape` as the five
// above, which is what lets one collector endpoint accept all seventeen and
// one worker order them on `(session_id, sequence_number)`. `call_id` stays
// absent on them: no producer mints one for these types, so SPEC §11.5.4's
// FIFO floor is all a consumer has for pairing — recorded rather than fixed.

export const ResourceListStartEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("resource_list_start").default("resource_list_start"),
    payload: ResourceListStartPayloadSchema,
  })
  .strict();
export type ResourceListStartEvent = z.infer<typeof ResourceListStartEventSchema>;

export const ResourceListEndEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("resource_list_end").default("resource_list_end"),
    payload: ResourceListEndPayloadSchema,
  })
  .strict();
export type ResourceListEndEvent = z.infer<typeof ResourceListEndEventSchema>;

export const ResourceListErrorEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("resource_list_error").default("resource_list_error"),
    payload: ResourceListErrorPayloadSchema,
  })
  .strict();
export type ResourceListErrorEvent = z.infer<typeof ResourceListErrorEventSchema>;

export const ResourceReadStartEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("resource_read_start").default("resource_read_start"),
    payload: ResourceReadStartPayloadSchema,
  })
  .strict();
export type ResourceReadStartEvent = z.infer<typeof ResourceReadStartEventSchema>;

export const ResourceReadEndEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("resource_read_end").default("resource_read_end"),
    payload: ResourceReadEndPayloadSchema,
  })
  .strict();
export type ResourceReadEndEvent = z.infer<typeof ResourceReadEndEventSchema>;

export const ResourceReadErrorEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("resource_read_error").default("resource_read_error"),
    payload: ResourceReadErrorPayloadSchema,
  })
  .strict();
export type ResourceReadErrorEvent = z.infer<typeof ResourceReadErrorEventSchema>;

export const PromptListStartEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("prompt_list_start").default("prompt_list_start"),
    payload: PromptListStartPayloadSchema,
  })
  .strict();
export type PromptListStartEvent = z.infer<typeof PromptListStartEventSchema>;

export const PromptListEndEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("prompt_list_end").default("prompt_list_end"),
    payload: PromptListEndPayloadSchema,
  })
  .strict();
export type PromptListEndEvent = z.infer<typeof PromptListEndEventSchema>;

export const PromptListErrorEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("prompt_list_error").default("prompt_list_error"),
    payload: PromptListErrorPayloadSchema,
  })
  .strict();
export type PromptListErrorEvent = z.infer<typeof PromptListErrorEventSchema>;

export const PromptGetStartEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("prompt_get_start").default("prompt_get_start"),
    payload: PromptGetStartPayloadSchema,
  })
  .strict();
export type PromptGetStartEvent = z.infer<typeof PromptGetStartEventSchema>;

export const PromptGetEndEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("prompt_get_end").default("prompt_get_end"),
    payload: PromptGetEndPayloadSchema,
  })
  .strict();
export type PromptGetEndEvent = z.infer<typeof PromptGetEndEventSchema>;

export const PromptGetErrorEventSchema = z
  .object({
    ...envelopeShape,
    event_type: z.literal("prompt_get_error").default("prompt_get_error"),
    payload: PromptGetErrorPayloadSchema,
  })
  .strict();
export type PromptGetErrorEvent = z.infer<typeof PromptGetErrorEventSchema>;

// =============================================================================
// Discriminated union — mirrors Python's `Event` (discriminator: event_type)
// =============================================================================

export const EventSchema = z.discriminatedUnion("event_type", [
  ToolCallStartEventSchema,
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  AnnotationEventSchema,
  SurfaceSnapshotEventSchema,
  ResourceListStartEventSchema,
  ResourceListEndEventSchema,
  ResourceListErrorEventSchema,
  ResourceReadStartEventSchema,
  ResourceReadEndEventSchema,
  ResourceReadErrorEventSchema,
  PromptListStartEventSchema,
  PromptListEndEventSchema,
  PromptListErrorEventSchema,
  PromptGetStartEventSchema,
  PromptGetEndEventSchema,
  PromptGetErrorEventSchema,
]);
export type Event =
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ToolCallErrorEvent
  | AnnotationEvent
  | SurfaceSnapshotEvent
  | ResourceListStartEvent
  | ResourceListEndEvent
  | ResourceListErrorEvent
  | ResourceReadStartEvent
  | ResourceReadEndEvent
  | ResourceReadErrorEvent
  | PromptListStartEvent
  | PromptListEndEvent
  | PromptListErrorEvent
  | PromptGetStartEvent
  | PromptGetEndEvent
  | PromptGetErrorEvent;
