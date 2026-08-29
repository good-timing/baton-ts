/**
 * Differential test for the vendored port in `src/integrations/mcp/zodCompat.ts`.
 *
 * That module is a hand-copy of helpers the official SDK 1.x keeps in
 * `server/zod-compat.js` and `server/zod-json-schema-compat.js`. Copying them
 * is what lets this package drop its runtime dependency on 1.x and install
 * for a v2-only vendor — but a copy is only safe while it still agrees with
 * the original, and the thing it feeds (`toolInputJsonSchema`) is hashed into
 * `surface_snapshot`, so a silent drift would invalidate every pinned hash.
 *
 * Same discipline as the scrub parity test: run both implementations over one
 * shared corpus and diff the output, rather than assert what we think the
 * output should be. 1.x stays a devDependency for exactly this.
 */

import {
  getObjectShape as sdkGetObjectShape,
  isZ4Schema as sdkIsZ4Schema,
  normalizeObjectSchema as sdkNormalizeObjectSchema,
  objectFromShape as sdkObjectFromShape,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat as sdkToJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { describe, expect, it } from "vitest";
import {
  getObjectShape,
  isZ4Schema,
  normalizeObjectSchema,
  objectFromShape,
  toJsonSchemaCompat,
} from "../../../src/integrations/mcp/zodCompat.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Object schemas, both majors, covering what a vendor's tool realistically
 * declares — and the shapes that make the two implementations branch. */
const SCHEMAS: Record<string, unknown> = {
  v4_simple: z.object({ a: z.string(), b: z.number().optional() }),
  v4_described: z.object({ a: z.string().describe("what a is"), b: z.boolean() }),
  v4_nested: z.object({ o: z.object({ n: z.array(z.string()) }), e: z.enum(["x", "y"]) }),
  v4_union: z.object({ u: z.union([z.string(), z.number()]), r: z.record(z.string(), z.unknown()) }),
  v4_empty: z.object({}),
  v3_simple: z3.object({ a: z3.string(), b: z3.number().optional() }),
  v3_described: z3.object({ a: z3.string().describe("what a is"), b: z3.boolean() }),
  v3_nested: z3.object({ o: z3.object({ n: z3.array(z3.string()) }), e: z3.enum(["x", "y"]) }),
  v3_empty: z3.object({}),
};

/** Things that are NOT object schemas — every one a real `inputSchema` value
 * `normalizeObjectSchema` has to classify. */
const NON_OBJECTS: Record<string, unknown> = {
  raw_shape_v4: { a: z.string(), b: z.number().optional() },
  raw_shape_v3: { a: z3.string() },
  empty_record: {},
  scalar_schema: z.string(),
  undefined_value: undefined,
  null_value: null,
  plain_record: { a: 1, b: "two" },
};

describe("zodCompat is byte-identical to the 1.x helpers it ports", () => {
  it("isZ4Schema agrees on every corpus entry the original can be called with", () => {
    for (const [name, schema] of Object.entries({ ...SCHEMAS, ...NON_OBJECTS })) {
      if (schema === undefined || schema === null) continue; // see next test
      expect(isZ4Schema(schema), name).toBe(sdkIsZ4Schema(schema as any));
    }
  });

  it("isZ4Schema is nullish-safe where the original throws — the one deliberate divergence", () => {
    // 1.x reads `s._zod` unguarded, so a nullish argument is a TypeError.
    // Unreachable through 1.x's own callers and through ours (every call site
    // has already checked), so the port keeps the optional chain rather than
    // copying a crash into a module whose callers would be the ones to hit
    // it. Pinned here so the divergence stays a decision, not a drift.
    for (const nullish of [undefined, null]) {
      expect(isZ4Schema(nullish)).toBe(false);
      expect(() => sdkIsZ4Schema(nullish as any)).toThrow(TypeError);
    }
  });

  it("getObjectShape returns the same field names", () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      const mine = getObjectShape(schema);
      const theirs = sdkGetObjectShape(schema as any);
      expect(Object.keys(mine ?? {}).sort(), name).toEqual(Object.keys(theirs ?? {}).sort());
    }
  });

  it("normalizeObjectSchema classifies objects, raw shapes and non-schemas the same way", () => {
    for (const [name, value] of Object.entries({ ...SCHEMAS, ...NON_OBJECTS })) {
      const mine = normalizeObjectSchema(value);
      const theirs = sdkNormalizeObjectSchema(value as any);
      expect(mine === undefined, `${name} definedness`).toBe(theirs === undefined);
      if (mine !== undefined && theirs !== undefined) {
        // Same normalised shape, and the same zod major to build into.
        expect(Object.keys(getObjectShape(mine) ?? {}).sort(), name).toEqual(
          Object.keys(sdkGetObjectShape(theirs as any) ?? {}).sort(),
        );
        expect(isZ4Schema(mine), `${name} major`).toBe(sdkIsZ4Schema(theirs as any));
      }
    }
  });

  it("objectFromShape builds in the same major, and defaults an empty shape to v4", () => {
    for (const [name, shape] of Object.entries({
      v4: { a: z.string() },
      v3: { a: z3.string() },
      empty: {},
    })) {
      expect(isZ4Schema(objectFromShape(shape)), name).toBe(
        sdkIsZ4Schema(sdkObjectFromShape(shape as any)),
      );
    }
  });

  it("objectFromShape throws on a mixed-major shape, like the original", () => {
    const mixed = { a: z.string(), b: z3.string() };
    expect(() => objectFromShape(mixed)).toThrow(/Mixed Zod versions/);
    expect(() => sdkObjectFromShape(mixed as any)).toThrow(/Mixed Zod versions/);
  });

  it("toJsonSchemaCompat emits byte-identical JSON — the surface-hash guarantee", () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      const opts = { strictUnions: true, pipeStrategy: "input" as const };
      expect(JSON.stringify(toJsonSchemaCompat(schema, opts)), name).toBe(
        JSON.stringify(sdkToJsonSchemaCompat(schema as any, opts)),
      );
    }
  });

  it("toJsonSchemaCompat matches on a schema carrying Baton's own injected params", () => {
    // The shape that actually reaches the converter after injection, built
    // the way schemaCompat builds it (via objectFromShape → ZodMini).
    for (const zod of [z, z3] as const) {
      const vendor = { text: zod.string() };
      const injected = objectFromShape({
        ...vendor,
        user_goal: zod.string().optional().describe("goal"),
      });
      const theirs = sdkObjectFromShape({
        ...vendor,
        user_goal: zod.string().optional().describe("goal"),
      });
      const opts = { strictUnions: true, pipeStrategy: "input" as const };
      expect(JSON.stringify(toJsonSchemaCompat(injected, opts))).toBe(
        JSON.stringify(sdkToJsonSchemaCompat(theirs as any, opts)),
      );
    }
  });
});
