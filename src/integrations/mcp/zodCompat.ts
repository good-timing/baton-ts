/**
 * A faithful vendored port of the four zod v3/v4 helpers and the JSON Schema
 * conversion that the official SDK **1.x** keeps in `server/zod-compat.js` +
 * `server/zod-json-schema-compat.js`.
 *
 * Why vendored rather than imported. Those are deep imports into
 * `@modelcontextprotocol/sdk`, and a *runtime* one — so any module graph that
 * reaches `schemaCompat.ts` cannot load at all unless 1.x is installed. That
 * makes the package uninstallable for a vendor on the v2 packages
 * (`@modelcontextprotocol/server`), who has no reason to have 1.x in their
 * tree, which is the whole point of supporting v2. Copying ~90 lines buys
 * both majors one entry point and deletes a documented reach-in; the
 * alternatives (async `import()` behind a synchronous `withBaton`, or a
 * `createRequire` shim that has to survive a dual ESM/CJS build) buy neither.
 *
 * Ported faithfully, warts included — this code exists to reproduce what 1.x
 * *does*, not what it should do. `objectFromShape` returns `zod/v4-mini`
 * objects, which carry no `~standard.jsonSchema`; that is 1.x's own behaviour
 * for the schemas it renders and validates, so "improving" it here would
 * change 1.x-path output rather than preserve it. (The v2 path deliberately
 * does NOT come through here — see `schemaCompat.injectGoalParamsV2`.)
 *
 * Held safe by `test/integrations/mcp/zodCompat.test.ts`, which diffs every
 * function in this file against 1.x's originals over a shared corpus. 1.x
 * stays a devDependency for exactly that reason.
 *
 * Known residual: this resolves `zod` from OUR dependency tree, while 1.x's
 * own `tools/list` resolves it from ITS tree. Deduped in any normal install
 * (one hoisted zod), divergent only where a vendor carries two zod v4 copies
 * — the same class of risk 1.x already runs internally.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

import * as z3rt from "zod/v3";
import * as z4mini from "zod/v4-mini";
import { zodToJsonSchema } from "zod-to-json-schema";

/** Present on zod 4 (Classic and Mini) schemas; absent on zod 3.
 *
 * One deliberate divergence from the original, pinned by test: 1.x reads
 * `s._zod` unguarded and therefore throws a `TypeError` on `null`/`undefined`.
 * That is unreachable through 1.x's own call sites and through ours — every
 * caller has already checked — so this keeps the optional chain rather than
 * copy a crash into a module whose callers would be the ones to hit it. */
export function isZ4Schema(s: unknown): boolean {
  const schema = s as { _zod?: unknown } | null | undefined;
  return !!schema?._zod;
}

/** Build an object schema from a shape, in the shape's own zod major. */
export function objectFromShape(shape: Record<string, unknown>): unknown {
  const values = Object.values(shape);
  if (values.length === 0) return z4mini.object({}); // default to v4 Mini
  const allV4 = values.every(isZ4Schema);
  const allV3 = values.every((s) => !isZ4Schema(s));
  if (allV4) return z4mini.object(shape as any);
  if (allV3) return z3rt.object(shape as any);
  throw new Error("Mixed Zod versions detected in object shape.");
}

/** The field map of an object schema. v3 exposes `.shape`; v4 keeps it on
 * `_zod.def.shape`, and either may be a thunk. */
export function getObjectShape(schema: unknown): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  let rawShape: unknown;
  if (isZ4Schema(schema)) {
    rawShape = (schema as any)._zod?.def?.shape;
  } else {
    rawShape = (schema as any).shape;
  }
  if (!rawShape) return undefined;
  if (typeof rawShape === "function") {
    try {
      return (rawShape as () => Record<string, unknown>)();
    } catch {
      return undefined;
    }
  }
  return rawShape as Record<string, unknown>;
}

/** Normalise to an object schema, accepting either an already-constructed
 * object schema (v3 or v4) or a raw shape that needs wrapping. Returns
 * `undefined` for anything else — including a non-object schema, which is
 * how a tool with no spliceable `inputSchema` is left alone. */
export function normalizeObjectSchema(schema: unknown): unknown {
  if (!schema) return undefined;

  if (typeof schema === "object") {
    const asAny = schema as any;
    // No `_def`/`_zod` means it is not a schema instance, so it may be a raw
    // shape — confirmed heuristically by every value being schema-like.
    if (!asAny._def && !asAny._zod) {
      const values = Object.values(schema as Record<string, unknown>);
      if (
        values.length > 0 &&
        values.every(
          (v: any) =>
            typeof v === "object" &&
            v !== null &&
            (v._def !== undefined || v._zod !== undefined || typeof v.parse === "function"),
        )
      ) {
        return objectFromShape(schema as Record<string, unknown>);
      }
    }
  }

  if (isZ4Schema(schema)) {
    const def = (schema as any)._zod?.def;
    if (def && (def.type === "object" || def.shape !== undefined)) return schema;
  } else {
    if ((schema as any).shape !== undefined) return schema;
  }
  return undefined;
}

export interface ToJsonSchemaOptions {
  target?: string | undefined;
  strictUnions?: boolean | undefined;
  pipeStrategy?: "input" | "output" | undefined;
}

function mapMiniTarget(t: string | undefined): "draft-7" | "draft-2020-12" {
  if (!t) return "draft-7";
  if (t === "jsonSchema7" || t === "draft-7") return "draft-7";
  if (t === "jsonSchema2019-09" || t === "draft-2020-12") return "draft-2020-12";
  return "draft-7";
}

/** JSON Schema for a zod v3 or v4 schema, in the exact spelling 1.x's own
 * `tools/list` emits. */
export function toJsonSchemaCompat(
  schema: unknown,
  opts?: ToJsonSchemaOptions,
): Record<string, unknown> {
  if (isZ4Schema(schema)) {
    return z4mini.toJSONSchema(schema as any, {
      target: mapMiniTarget(opts?.target),
      io: opts?.pipeStrategy ?? "input",
    });
  }
  return zodToJsonSchema(schema as any, {
    strictUnions: opts?.strictUnions ?? true,
    pipeStrategy: opts?.pipeStrategy ?? "input",
  });
}
