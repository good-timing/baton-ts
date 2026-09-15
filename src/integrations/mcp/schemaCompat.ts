/**
 * Intent-param injection for the official SDK's **1.x** `McpServer`.
 *
 * Splicing `user_goal`/`expected_result`/`overall_task` into a vendor's
 * EXISTING Zod object schema has to build the injected fields with a schema
 * instance from the SAME zod major as the tool's other fields — a vendor on
 * 1.x may be on zod v3 or v4, and `objectFromShape` throws on a mixed-version
 * shape. The v3/v4 bridge that makes that work is `./zodCompat.js`, a
 * vendored port of the helpers 1.x uses internally; see that module for why
 * it is copied rather than imported (short version: the import is a runtime
 * one, and it would make this package uninstallable for a v2-only vendor).
 *
 * The v2 packages need none of this — `injectGoalParamsV2`, below.
 */

import {
  getObjectShape,
  isZ4Schema,
  normalizeObjectSchema,
  objectFromShape,
  toJsonSchemaCompat,
} from "./zodCompat.js";
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

/** The sliver of a zod namespace the injected fields need — written
 * structurally so the same builder serves zod v3, zod v4, and whichever
 * instance the vendor's own schema was built with. */
interface DescribableField {
  describe(description: string): unknown;
}
interface StringFieldFactory {
  string(): DescribableField & { optional(): DescribableField };
}
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
 *
 * `intentParamMode` selects only `user_goal`'s description label ("REQUIRED."
 * or "OPTIONAL."). It never makes a field enforcing: the advertisement of
 * `required` happens on the `tools/list` RESPONSE, in withBaton.ts, and
 * `buildIntentFields` says why it cannot happen here.
 */
export function injectGoalParams(
  inputSchema: unknown,
  intentParamMode: IntentParamMode,
): {
  schema: unknown;
  dispositions: IntentParamDispositions;
} {
  const objSchema = normalizeObjectSchema(inputSchema);
  if (!objSchema) return { schema: inputSchema, dispositions: {} };
  const existingShape = getObjectShape(objSchema) ?? {};
  const values = Object.values(existingShape);
  // Empty shape: default to v4, matching objectFromShape's own default.
  const useV4 = values.length === 0 || isZ4Schema(values[0]);
  const zodImpl = useV4 ? zV4 : zV3;

  const { dispositions, toInject } = buildIntentFields(existingShape, zodImpl, intentParamMode);

  if (Object.keys(toInject).length === 0)
    return { schema: inputSchema, dispositions };
  const mergedShape = { ...existingShape, ...toInject };
  const newSchema = objectFromShape(mergedShape);
  return { schema: newSchema, dispositions };
}

/** The intent fields to splice, and what each name's disposition is. Shared
 * by both SDK majors so the two injection paths cannot drift on which
 * params exist, which are promoted by `mode`, or when a vendor's own field
 * of the same name wins. */
function buildIntentFields(
  existingShape: Record<string, unknown>,
  zodImpl: StringFieldFactory,
  intentParamMode: IntentParamMode,
): {
  dispositions: IntentParamDispositions;
  toInject: Record<string, unknown>;
} {
  const dispositions: IntentParamDispositions = {};
  const toInject: Record<string, unknown> = {};

  // EVERY injected field is optional in the zod schema, in EVERY mode. That
  // is the change of 2026-09-01 (D7 in baton-internal
  // `intent_param_injection.md`), not an oversight.
  //
  // `required` used to build a non-optional zod field here, on the VENDOR'S
  // OWN schema, so an agent that omitted `user_goal` had its call refused by
  // the vendor's server: Baton breaking a customer's product to collect a
  // telemetry string. For a wrapper whose whole claim is that it does not
  // change how the wrapped server behaves, that is the wrong trade at any
  // capture rate, so `required` means what it means in the proxy and in
  // Python: ADVERTISED as required, never enforced.
  //
  // The advertisement cannot come from a zod expression, and the reason is
  // structural. Measured 2026-09-01 against both zod majors this package
  // supports:
  //
  //   zod v4  .optional()            -> required: ["a"]              parses: true
  //   zod v4  union([string,undef])  -> required: ["a","user_goal"]  parses: FALSE
  //   zod v3  .optional()            -> required: ["a"]              parses: true
  //   zod v3  union([string,undef])  -> required: ["a"]              parses: true
  //
  // In v4 advertised-required and enforced are the same bit; in v3 the
  // advertisement is unreachable at all. Python holds the two apart by
  // editing the rendered JSON Schema of a `tools/list` RESPONSE, and since
  // 2026-09-15 this package does the same: withBaton.ts wraps the SDK's
  // `tools/list` handler and `advertiseUserGoalRequired` (below) appends
  // `user_goal` to each injected tool's advertised `required`. The zod field
  // built here stays optional, so validation is unchanged and a call that
  // omits `user_goal` still reaches the vendor's handler.
  //
  // What `intentParamMode` still selects here is the description's leading
  // label, so the text never contradicts the schema it ships inside.
  if (USER_GOAL_PARAM_NAME in existingShape) {
    dispositions[USER_GOAL_PARAM_NAME] = "native";
  } else {
    dispositions[USER_GOAL_PARAM_NAME] = "injected";
    toInject[USER_GOAL_PARAM_NAME] = zodImpl
      .string()
      .optional()
      .describe(buildUserGoalParamDescription({ intentParamMode }));
  }

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

  return { dispositions, toInject };
}

/**
 * The same splice for the official SDK's **v2** packages, which need none of
 * this module's compat machinery: v2 refuses zod v3 outright (the schema
 * registers, then throws inside the `tools/list` handler and fails the whole
 * list), so there is no mixed-major case to bridge.
 *
 * Extends the vendor's own schema rather than rebuilding one from its field
 * map. `zV4.object({ ...schema.shape, ...injected })` recovers only the
 * fields and silently discards every object-level semantic the vendor
 * attached — measured: a tool declared `z.object({a,b}).refine(v => v.a !==
 * v.b)` then accepted `{a:"x", b:"x"}`, handing the vendor's handler
 * arguments its own schema rejects, and a `z.strictObject` quietly stripped
 * unknown keys instead of refusing them. Installing Baton must not weaken a
 * vendor's validation. `.extend()` keeps checks and `additionalProperties`
 * (measured: the violating call above is now rejected at the protocol layer,
 * exactly as it would be on the unwrapped tool) and still renders the
 * injected params on `tools/list`.
 *
 * One consequence worth knowing: the vendor's refinements now run over the
 * arguments *including* `user_goal`/`expected_result`/`overall_task`, since
 * v2 validates before dispatch and the strip happens in our wrapper after.
 * A refinement over key counts or unknown keys would therefore observe
 * Baton's params. Rare, and the alternative is dropping the refinement
 * entirely.
 *
 * Returns the schema unchanged when there is nothing safe to extend — a
 * non-zod `StandardSchemaWithJSON` (ArkType, Valibot, hand-rolled: v2's
 * primary `registerTool` overload takes any of them, and none has `.extend`).
 * Such a tool is still wrapped and still emits `tool_call_*`; it just carries
 * no injected intent params. Deliberately NOT falling back to a rebuild
 * there — a rebuild is the semantics loss this function exists to avoid.
 * Making injection work for those schemas means decorating
 * `~standard.jsonSchema.input()`, which advertises fine but leaves validation
 * with the vendor's own schema.
 *
 * The 1.x path above has the same rebuild-loses-modifiers gap, documented in
 * `injectGoalParams`; it is not changed here because it goes through
 * `objectFromShape` and the zod-mini objects 1.x itself renders.
 *
 * `intentParamMode` selects the `user_goal` label only, as in
 * `injectGoalParams` above.
 */
export function injectGoalParamsV2(
  inputSchema: unknown,
  intentParamMode: IntentParamMode,
): {
  schema: unknown;
  dispositions: IntentParamDispositions;
} {
  const candidate = inputSchema as
    | {
        shape?: Record<string, unknown>;
        extend?: (fields: Record<string, unknown>) => unknown;
      }
    | undefined;
  const shape = candidate?.shape;
  if (
    !shape ||
    typeof shape !== "object" ||
    typeof candidate?.extend !== "function"
  ) {
    return { schema: inputSchema, dispositions: {} };
  }

  const { dispositions, toInject } = buildIntentFields(shape, zV4, intentParamMode);
  if (Object.keys(toInject).length === 0)
    return { schema: inputSchema, dispositions };
  return { schema: candidate.extend(toInject), dispositions };
}

/**
 * The advertisement half of `intentParamMode: "required"`, applied to a
 * RENDERED `tools/list` result: `user_goal` is appended to the `required`
 * array (created when absent) of every tool `isInjected` names, and nothing
 * else changes. Copy on write, so the SDK's own result, and anything it
 * shares with a memo, is never mutated, and a caller that catches a throw
 * from here can serve the original untouched.
 *
 * Only the RESPONSE changes. The zod schema the SDK validates with is never
 * touched, so a call omitting `user_goal` still passes validation and still
 * reaches the vendor's handler: advertised as required, never enforced.
 */
export function advertiseUserGoalRequired(
  result: unknown,
  isInjected: (toolName: string) => boolean,
): unknown {
  const tools = (result as { tools?: unknown } | null | undefined)?.tools;
  if (!Array.isArray(tools)) return result;
  let changed = false;
  const advertised = tools.map((tool: unknown) => {
    const entry = tool as { name?: unknown; inputSchema?: unknown } | null;
    if (typeof entry?.name !== "string" || !isInjected(entry.name)) return tool;
    const schema = entry.inputSchema as { required?: unknown } | null | undefined;
    if (!schema || typeof schema !== "object") return tool;
    const declared: unknown = schema.required ?? [];
    if (!Array.isArray(declared)) return tool;
    const required = declared as unknown[];
    if (required.includes(USER_GOAL_PARAM_NAME)) return tool;
    changed = true;
    return { ...entry, inputSchema: { ...schema, required: [...required, USER_GOAL_PARAM_NAME] } };
  });
  return changed ? { ...(result as Record<string, unknown>), tools: advertised } : result;
}

/** The vendor-true JSON Schema for a tool's `inputSchema` — same conversion
 * (`toJsonSchemaCompat`, matching options) the SDK 1.x itself uses to build
 * `tools/list`'s advertised `inputSchema`, so the surface snapshot matches
 * byte-for-byte what the client actually receives. Call BEFORE
 * `injectGoalParams` mutates the entry, so the snapshot reflects the
 * vendor's real schema, not Baton's addition.
 *
 * 1.x only: on v2, `withBaton` reads the server's own converted schema
 * instead, because v2 renders `tools/list` with a different one. */
export function toolInputJsonSchema(
  inputSchema: unknown,
): Record<string, unknown> {
  const objSchema = normalizeObjectSchema(inputSchema);
  if (!objSchema) return EMPTY_OBJECT_JSON_SCHEMA;
  return toJsonSchemaCompat(objSchema, {
    strictUnions: true,
    pipeStrategy: "input",
  });
}
