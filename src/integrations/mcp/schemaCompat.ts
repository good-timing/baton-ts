/**
 * Reach-in to `@modelcontextprotocol/sdk`'s internal zod v3/v4 bridge
 * (`server/zod-compat.js` + `server/zod-json-schema-compat.js`) — the same
 * helpers the SDK itself uses so a tool's `inputSchema` can be either zod
 * major version. Needed because intent-param injection splices
 * `user_goal`/`expected_result` into a vendor's EXISTING Zod object schema,
 * and that schema may be v3 or v4 depending on the vendor's own `zod`
 * dependency — `objectFromShape` throws on a mixed-version shape, so the
 * two injected fields must be built with a schema instance from the SAME
 * major as the tool's other fields.
 *
 * Like `_registeredTools`/`_instructions` in withBaton.ts, this is a
 * documented, single swap point for an upstream internals change. Unlike
 * those two, this reach-in IS reachable through the package's real (if
 * unofficial) `./*` wildcard export and ships its own `.d.ts` — a better-
 * typed reach-in than the other two, not a new category of risk.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import {
  getObjectShape,
  isZ4Schema,
  normalizeObjectSchema,
  objectFromShape,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z as zV4 } from "zod";
import { z as zV3 } from "zod/v3";
import {
  EXPECTED_RESULT_PARAM_NAME,
  OVERALL_TASK_PARAM_NAME,
  USER_GOAL_PARAM_NAME,
  buildExpectedResultParamDescription,
  buildOverallTaskParamDescription,
  buildUserGoalParamDescription,
} from "./llmText.js";

export type IntentParamMode = "optional" | "required" | "off";
export type IntentParamDispositions = Record<string, "injected" | "native">;

// Mirrors mcp.js's private EMPTY_OBJECT_JSON_SCHEMA — used identically by
// the SDK's own tools/list handler when a tool declares no inputSchema.
const EMPTY_OBJECT_JSON_SCHEMA = { type: "object", properties: {} };

/**
 * Splice `user_goal`/`expected_result`/`overall_task` into `inputSchema`'s
 * object shape.
 * Returns the original schema unchanged (with empty dispositions) when
 * there's no object schema to extend into — a tool with no `inputSchema` at
 * all is left alone rather than given one, because adding a schema where
 * none existed would flip the SDK's handler-calling convention from
 * `(extra)` to `(args, extra)` and break the vendor's own zero-arg handler.
 *
 * Known fidelity gap: rebuilding via `objectFromShape` recovers only the
 * field map (`getObjectShape`), not object-level modifiers the vendor's
 * schema may have carried (`.strict()`/`.passthrough()`/`.refine()`).
 * Python's JSON-schema-dict injection has no equivalent loss (JSON Schema
 * has no refinement concept to lose); this is a TS-specific, accepted gap.
 */
export function injectGoalParams(
  inputSchema: unknown,
  mode: "optional" | "required",
): { schema: unknown; dispositions: IntentParamDispositions } {
  const objSchema = normalizeObjectSchema(inputSchema as any);
  if (!objSchema) return { schema: inputSchema, dispositions: {} };
  const existingShape = getObjectShape(objSchema) ?? {};
  const values = Object.values(existingShape);
  // Empty shape: default to v4, matching objectFromShape's own default.
  const useV4 = values.length === 0 || isZ4Schema(values[0] as any);
  const zodImpl = useV4 ? zV4 : zV3;

  const dispositions: IntentParamDispositions = {};
  const toInject: Record<string, unknown> = {};

  if (USER_GOAL_PARAM_NAME in existingShape) {
    dispositions[USER_GOAL_PARAM_NAME] = "native";
  } else {
    dispositions[USER_GOAL_PARAM_NAME] = "injected";
    const field =
      mode === "required" ? zodImpl.string() : zodImpl.string().optional();
    toInject[USER_GOAL_PARAM_NAME] = field.describe(buildUserGoalParamDescription());
  }

  // `expected_result` and `overall_task` stay optional regardless of mode —
  // only `user_goal` is promoted to required, matching Python's
  // `_inject_goal_params`.
  for (const [name, buildDescription] of [
    [EXPECTED_RESULT_PARAM_NAME, buildExpectedResultParamDescription],
    [OVERALL_TASK_PARAM_NAME, buildOverallTaskParamDescription],
  ] as const) {
    if (name in existingShape) {
      dispositions[name] = "native";
    } else {
      dispositions[name] = "injected";
      toInject[name] = zodImpl.string().optional().describe(buildDescription());
    }
  }

  if (Object.keys(toInject).length === 0) return { schema: inputSchema, dispositions };
  const mergedShape = { ...existingShape, ...toInject };
  const newSchema = objectFromShape(mergedShape as any);
  return { schema: newSchema, dispositions };
}

/** The vendor-true JSON Schema for a tool's `inputSchema` — same conversion
 * (`toJsonSchemaCompat`, matching options) the SDK itself uses to build
 * `tools/list`'s advertised `inputSchema`, so the surface snapshot matches
 * byte-for-byte what the client actually receives. Call BEFORE
 * `injectGoalParams` mutates the entry, so the snapshot reflects the
 * vendor's real schema, not Baton's addition. */
export function toolInputJsonSchema(inputSchema: unknown): Record<string, unknown> {
  const objSchema = normalizeObjectSchema(inputSchema as any);
  if (!objSchema) return EMPTY_OBJECT_JSON_SCHEMA;
  return toJsonSchemaCompat(objSchema, { strictUnions: true, pipeStrategy: "input" });
}
