/**
 * Wire-conformance test — the load-bearing check per CHARTER: TS-emitted
 * events must be JSON-identical in shape to Python-emitted events (only
 * `sdk_version`/`event_id`/`captured_at`/`sequence_number` may differ).
 *
 * Two checks, both against `baton-spec` (the neutral schema repo, not this
 * repo's own copy of anything):
 *  1. Every real, Python-captured vector in `baton-spec/vectors/*.json`
 *     parses through our Zod schemas byte-for-byte (same keys, same values).
 *  2. `events.schema.json` (ajv) accepts both the vectors AND a
 *     minimally-populated event built from our own Zod schemas — proving
 *     our defaults also produce schema-valid output, not just our own
 *     re-serialization of someone else's example.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  EventSchema,
  ToolCallStartEventSchema,
  ToolCallEndEventSchema,
  ToolCallErrorEventSchema,
  AnnotationEventSchema,
  SurfaceSnapshotEventSchema,
} from "../src/events.js";

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

  it("minimally-populated TS-built events of every type are schema-valid", () => {
    const common = {
      tenant_id: "t",
      vendor_id: "v",
      session_id: "s",
      sequence_number: 0,
      captured_at: new Date().toISOString(),
      consent_token: "ct",
    };
    const built = [
      ToolCallStartEventSchema.parse({ ...common, payload: { tool_name: "x" } }),
      ToolCallEndEventSchema.parse({ ...common, payload: { tool_name: "x" } }),
      ToolCallErrorEventSchema.parse({
        ...common,
        payload: { tool_name: "x", error_type: "Error", error_body: "boom" },
      }),
      AnnotationEventSchema.parse({ ...common, payload: {} }),
      SurfaceSnapshotEventSchema.parse({ ...common, payload: { surface_hash: "sha256:abc" } }),
    ];
    for (const event of built) {
      const serialized = JSON.parse(JSON.stringify(event));
      const valid = validate(serialized);
      expect(valid, ajv.errorsText(validate.errors)).toBe(true);
    }
  });
});
