/** The library's `listTools`: the tool list a vendor serving MCP itself hands
 * its agents, and the `surface_snapshot` of the list it started from (SPEC
 * §5.6, §11.4.2). */

import {
  buildUserGoalParamDescription,
  declaresParam,
  requiredParamNames,
  USER_GOAL_PARAM_NAME,
} from "../integrations/mcp/llmText.js";
import { DEFAULT_INTENT_PARAM_MODE } from "../integrations/mcp/schemaCompat.js";
import { assembleSurface, buildSeamAugmentations, surfaceHash, type ServerMeta } from "../integrations/mcp/surface.js";
import { printable } from "../warn.js";
import { isRecord } from "../_object.js";

/** The vendor's own `initialize` values, as it serves them. */
export interface ListToolsOptions {
  serverInfo?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
  instructions?: string | null;
}

export interface Surface {
  surface: Record<string, unknown>;
  digest: string;
}

/** `tools` with `user_goal` added, and the surface of `tools` as passed with
 * its hash. Never throws: a list it cannot read is served as it
 * came, with no surface. */
export function serveTools<T>(
  tools: readonly T[],
  options: ListToolsOptions,
): { served: T[]; surface: Surface | null } {
  let served: T[];
  try {
    served = tools.map(servedEntry);
  } catch (err) {
    process.stderr.write(`baton: could not add user_goal to the tool list; serving it unchanged: ${printable(err)}\n`);
    return { served: tools as T[], surface: null };
  }
  try {
    // Sorted so the same tools in another order hash the same, as in the adapters.
    const nameOf = (tool: unknown) => (isRecord(tool) ? String(tool.name) : "");
    const ordered = [...tools].sort((a, b) => {
      const [x, y] = [nameOf(a), nameOf(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const meta = {
      server_info: options.serverInfo ?? null,
      capabilities: options.capabilities ?? null,
      instructions: options.instructions ?? null,
    } as ServerMeta;
    // Copied because a queued snapshot outlives the vendor's objects.
    const surface = JSON.parse(
      JSON.stringify(assembleSurface(meta, ordered as Array<Record<string, unknown>>)),
    ) as Record<string, unknown>;
    return { served, surface: { surface, digest: surfaceHash(surface) } };
  } catch (err) {
    process.stderr.write(`baton: surface snapshot capture failed: ${printable(err)}\n`);
    return { served, surface: null };
  }
}

export function snapshotPayload({ surface, digest }: Surface): Record<string, unknown> {
  return {
    surface_hash: digest,
    ...surface,
    seam_augmentations: buildSeamAugmentations({
      injectedToolNames: [],
      intentParamNames: [USER_GOAL_PARAM_NAME],
      intentParamMode: DEFAULT_INTENT_PARAM_MODE,
      requiredParamNames: requiredParamNames(DEFAULT_INTENT_PARAM_MODE),
      instructionsSuffix: null,
    }),
  };
}

function servedEntry<T>(tool: T): T {
  if (!isRecord(tool)) return tool;
  const entry: Record<string, unknown> = { ...tool };
  if (isRecord(entry.inputSchema)) {
    // Only these levels change, so only they are copied.
    const schema: Record<string, unknown> = { ...entry.inputSchema };
    if (isRecord(schema.properties)) schema.properties = { ...schema.properties };
    injectGoalParam(schema);
    entry.inputSchema = schema;
  }
  return entry as T;
}

/** Python's `inject_goal_params` on a JSON Schema object, in place. A tool
 * that declares `user_goal` itself keeps its own. */
function injectGoalParam(schema: Record<string, unknown>): void {
  // `undefined` counts as missing: JSON drops the key, so the agent would see none.
  if (schema.properties === undefined) schema.properties = {};
  if (!isRecord(schema.properties) || declaresParam(schema, USER_GOAL_PARAM_NAME)) return;
  schema.properties[USER_GOAL_PARAM_NAME] = {
    type: "string",
    description: buildUserGoalParamDescription({ intentParamMode: DEFAULT_INTENT_PARAM_MODE }),
  };
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  if (!required.includes(USER_GOAL_PARAM_NAME)) schema.required = [...required, USER_GOAL_PARAM_NAME];
}
