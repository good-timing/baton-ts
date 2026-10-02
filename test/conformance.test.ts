/**
 * Wire-conformance test — the load-bearing check per CHARTER: TS-emitted
 * events must be JSON-identical in shape to Python-emitted events (only
 * `sdk_version`/`event_id`/`captured_at`/`sequence_number` may differ).
 *
 * Everything here checks against `baton-spec` (the neutral schema repo, not this
 * repo's own copy of anything):
 *  1. Every real, Python-captured vector in `baton-spec/vectors/*.json`
 *     parses through our Zod schemas byte-for-byte (same keys, same values).
 *  2. `events.schema.json` (ajv) accepts the vectors AND events built from our
 *     own Zod schemas — proving our defaults also produce schema-valid output,
 *     not just our own re-serialization of someone else's example. Built BOTH
 *     minimally and maximally, for every event type: see (a)/(b)/(c) below,
 *     which are the reasons the maximal half and the per-type binding exist.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
// Ten per-type schema imports stood here. They are gone because
// `PAYLOAD_SCHEMAS` below DERIVES the type→schema map from `EventSchema`'s
// branches, and `EventSchema.parse` dispatches on `event_type` — so naming each
// branch was the hand-copy the derivation replaces.
import { EventSchema, EventTypeSchema } from "../src/events.js";
import type { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.join(here, "..", "baton-spec");
const schema = JSON.parse(readFileSync(path.join(specDir, "events.schema.json"), "utf-8"));
const vectorsDir = path.join(specDir, "vectors");
const vectorFiles = readdirSync(vectorsDir).filter((f) => f.endsWith(".json"));

// strict:false — events.schema.json is exported from baton-sdk (Python)'s
// Pydantic models, not authored for ajv; its oneOf/discriminator root has no
// top-level "type", which ajv's strict mode flags but the schema is
// otherwise valid and not this repo's to edit (baton-spec is the schema of
// record — see baton-spec/README.md). ajv's own `discriminator` keyword
// doesn't support the OpenAPI `mapping` form Pydantic exports, but plain
// `oneOf` validation (each branch has a `const` on `event_type`) works
// without it, so the option is left off rather than fighting the format.
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("baton-spec conformance", () => {
  it.each(vectorFiles)("vector %s validates against events.schema.json", (file) => {
    const data = JSON.parse(readFileSync(path.join(vectorsDir, file), "utf-8"));
    const valid = validate(data);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it.each(vectorFiles)("vector %s round-trips byte-identical through EventSchema", (file) => {
    const data = JSON.parse(readFileSync(path.join(vectorsDir, file), "utf-8"));
    const parsed = EventSchema.parse(data);
    // JSON round-trip, not just Zod's parsed object — proves our
    // serialization shape (key set, null-vs-undefined, nesting) matches
    // the Python-captured wire bytes, not just that Zod could coerce it.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(data);
  });

  /** ⚠ **The minimal case below cannot see an optional member.**
   *
   * It populates only what each payload REQUIRES, so a member this SDK can
   * emit but does not have to has never been validated against the pinned
   * schema. `result_capture` was the first to make that visible: the spec pin
   * could be reverted to `f1e0280` and all 496 tests still passed, while every
   * `"off"` event the SDK emits was rejected by the schema of record — both
   * tool-call payload definitions being `additionalProperties: false`. That is
   * the failure `CONTRIBUTING.md` names, "a stale pin makes these tests pass
   * loudly and prove nothing".
   *
   * Fixing it per-member would scale linearly with members and depend on
   * someone remembering. These two cases fix it generally:
   *
   * (a) validate a payload with EVERY member populated, so an optional one
   *     cannot hide; and
   * (b) assert each fixture's key set IS its Zod schema's key set — so adding
   *     a member to `src/events.ts` without bumping the `baton-spec` pin fails
   *     HERE, before anyone thinks to write a test for that member.
   *
   * (b) is what stops (a) rotting: without it, the fixtures silently go stale
   * the first time a member is added and (a) starts proving less than it says.
   */
  const MAXIMAL: Record<string, Record<string, unknown>> = {
    tool_call_start: {
      tool_name: "x",
      params: { a: 1 },
      call_intent: "why",
      call_expected: "what",
      call_workflow: "task",
      intent_source: "injected_param",
    },
    tool_call_end: {
      tool_name: "x",
      result: { content: [{ type: "text", text: "ok" }] },
      duration_ms: 3,
      result_capture: "off",
    },
    tool_call_error: {
      tool_name: "x",
      error_type: "tool_error",
      error_body: "boom",
      duration_ms: 3,
      result: { content: [], isError: true },
      result_capture: "off",
      failure_kind: "output_schema_mismatch",
    },
    // ⚠ `AnnotationPayloadSchema` and `SurfaceSnapshotPayloadSchema` are
    // `.default()` throughout today, so the minimal case reaches every member by
    // accident. The first `.optional()` on either reopens the `result_capture`
    // hole on the one payload pair nothing else here watches.
    annotation: {
      intent: "why",
      expected_outcome: "what",
      signal_type: "feature_gap",
      workflow: "task",
      suggested_improvement: "how",
      context: { a: 1 },
      intent_source: "injected_param",
      tool_name: "x",
    },
    surface_snapshot: {
      surface_hash: "sha256:abc",
      server_info: { name: "vendor", version: "1.0.0" },
      capabilities: { tools: {} },
      instructions: "do the thing",
      tools: [{ name: "x" }],
      seam_augmentations: { injected_tools: ["baton_annotate"] },
    },

    // ⚠ The twelve resource/prompt lifecycle payloads (SPEC §11.4.4). Their
    // shapes came from `baton-proxy`, which has been emitting all twelve in
    // production against no schema; these fixtures are what make them
    // schema-CHECKED here for the first time. Case (b) below is why every one
    // of them had to be written out rather than sampled.
    resource_list_start: {},
    resource_list_end: { count: 2, duration_ms: 3 },
    resource_list_error: { error_type: "-32002", error_body: "boom", duration_ms: 3 },
    resource_read_start: { uri: "file:///x", params: { uri: "file:///x" } },
    resource_read_end: { uri: "file:///x", duration_ms: 3 },
    resource_read_error: {
      uri: "file:///x",
      error_type: "-32002",
      error_body: "boom",
      duration_ms: 3,
    },
    prompt_list_start: {},
    prompt_list_end: { count: 2, duration_ms: 3 },
    prompt_list_error: { error_type: "-32602", error_body: "boom", duration_ms: 3 },
    prompt_get_start: { name: "p", params: { a: 1 } },
    prompt_get_end: { name: "p", duration_ms: 3 },
    prompt_get_error: { name: "p", error_type: "-32602", error_body: "boom", duration_ms: 3 },
  };

  /** Each event type and its payload schema, DERIVED from `EventSchema` —
   * the union is what decides what this SDK can emit and which payload goes
   * with it.
   *
   * ⚠ **Not `EventTypeSchema`, and not `EventType` either.** Measured: the enum
   * is consumed NOWHERE in `src/` — its own `z.enum`, a `z.infer` beside it, a
   * re-export — and the envelope does not reference it, so a type added to the
   * union and forgotten in the enum satisfies any binding to the enum.
   * `EventType` is that enum's `z.infer`, so a type annotation off it inherits
   * the same hole.
   *
   * `.parse(undefined)` returns the literal because every branch's `event_type`
   * carries `.default()` — public API, not internals. */
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
  /** ⚠ Reads the literal rather than `event_type.parse(undefined)`. That form
   * worked, and it put a convention nothing enforces on the import path: a
   * future branch written `z.literal("x")` WITHOUT `.default()` made this
   * initializer throw during module load, failing all 30 cases — including the
   * vector round-trips, which have nothing to do with the new type — under a
   * ZodError naming neither the branch nor the cause. Both spellings are
   * tolerated here, and a branch matching neither lands as `undefined` and reds
   * the registry case below BY NAME. */
  const literalOf = (branch: any): string =>
    branch.shape.event_type.def?.innerType?.value ?? branch.shape.event_type.value;

  const BRANCHES = Object.fromEntries(
    EventSchema.options.map((branch) => [literalOf(branch), branch]),
  ) as Record<string, z.ZodObject<Record<string, z.ZodType>>>;
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

  const PAYLOAD_SCHEMAS = Object.fromEntries(
    Object.entries(BRANCHES).map(([type, branch]) => [
      type,
      branch.shape.payload as z.ZodObject<Record<string, z.ZodType>>,
    ]),
  ) as Record<string, z.ZodObject<Record<string, z.ZodType>>>;

  /** The one thing the derivation cannot check for itself. `EventTypeSchema`
   * and `EventSchema`'s branch literals are maintained separately and
   * `EventType` is public API, so a type in one and not the other is a real
   * defect — just not the one the fixtures care about. */
  it("src/events.ts's two event-type registries agree", () => {
    expect(Object.keys(PAYLOAD_SCHEMAS).sort()).toEqual([...EventTypeSchema.options].sort());
  });

  /** Only the REQUIRED members of each payload — the complement of `MAXIMAL`.
   * Hand-written for its VALUES; its KEY SETS are asserted against the schemas
   * below, because nothing else would stop this arm quietly becoming a second
   * maximal one. (Copy an optional member in here the way one does into
   * `MAXIMAL`, and the only case proving our DEFAULTS produce schema-valid
   * output stops testing defaults — the same silent narrowing (c) exists to
   * prevent, one table along.) */
  const MINIMAL: Record<string, Record<string, unknown>> = {
    tool_call_start: { tool_name: "x" },
    tool_call_end: { tool_name: "x" },
    tool_call_error: { tool_name: "x", error_type: "Error", error_body: "boom" },
    annotation: {},
    surface_snapshot: { surface_hash: "sha256:abc" },
    // ⚠ The two `*_list_start` payloads are EMPTY in both tables, and that is
    // not a copy of the maximal arm going stale — those schemas declare no
    // members at all, so minimal and maximal genuinely coincide. The key-set
    // assertions below are what keep that honest if either ever gains one.
    resource_list_start: {},
    resource_list_end: { count: 2 },
    resource_list_error: { error_type: "-32002", error_body: "boom" },
    resource_read_start: { uri: "file:///x" },
    resource_read_end: { uri: "file:///x" },
    resource_read_error: { uri: "file:///x", error_type: "-32002", error_body: "boom" },
    prompt_list_start: {},
    prompt_list_end: { count: 2 },
    prompt_list_error: { error_type: "-32602", error_body: "boom" },
    prompt_get_start: { name: "p" },
    prompt_get_end: { name: "p" },
    prompt_get_error: { name: "p", error_type: "-32602", error_body: "boom" },
  };

  /** ⚠ **(c).** Both fixture tables are literals, so something must force a new
   * event type to acquire an entry — otherwise it gets no key-set assertion and
   * no optional member ever validated against the pinned schema, and (a) and (b)
   * narrow silently to "the types someone remembered". The sibling file does
   * this with the vectors DIRECTORY (`VECTORS_ON_DISK` → `CASES`). */
  it.each([
    ["maximal", MAXIMAL],
    ["minimal", MINIMAL],
  ] as const)("%s fixtures exist for every event type the SDK can emit", (_kind, fixtures) => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(PAYLOAD_SCHEMAS).sort());
  });

  /** `MINIMAL` is minimal BY DERIVATION: a member is required exactly when its
   * schema rejects `undefined`, which is the same question the parse asks. */
  it.each(Object.keys(MINIMAL))("%s: the minimal fixture is exactly the required members", (name) => {
    const required = Object.entries(PAYLOAD_SCHEMAS[name]!.shape)
      .filter(([, member]) => !member.safeParse(undefined).success)
      .map(([key]) => key);
    expect(Object.keys(MINIMAL[name]!).sort()).toEqual(required.sort());
  });

  it.each(Object.keys(MAXIMAL))(
    "%s: the maximal fixture covers every member its Zod schema declares",
    (name) => {
      expect(Object.keys(MAXIMAL[name]!).sort()).toEqual(
        Object.keys(PAYLOAD_SCHEMAS[name]!.shape).sort(),
      );
    },
  );

  const commonEnvelope = () => ({
    tenant_id: "t",
    vendor_id: "v",
    session_id: "s",
    sequence_number: 0,
    captured_at: new Date().toISOString(),
    consent_token: "ct",
  });

  /** Validated as well as key-set-checked: a fixture that only did the latter
   * would prove the shape matches our OWN Zod schema and never meet the schema
   * of record.
   *
   * ⚠ Parsed through the derived BRANCH with `event_type` OMITTED, which is what
   * the producer does (`withBaton.ts` never passes it) — so the defaulting path
   * is the one under test. Handing `event_type` to `EventSchema.parse` instead
   * validated a shape no emitter builds. */
  describe.each([
    ["maximal", MAXIMAL],
    ["minimal", MINIMAL],
  ] as const)("%s TS-built events", (_kind, fixtures) => {
    it.each(Object.keys(fixtures))("%s is valid against the PINNED schema", (name) => {
      const event = BRANCHES[name]!.parse({
        ...commonEnvelope(),
        payload: fixtures[name],
      });
      const valid = validate(JSON.parse(JSON.stringify(event)));
      expect(valid, ajv.errorsText(validate.errors)).toBe(true);
    });
  });
});
