/** The library's `listTools`: the tool list a vendor serving MCP itself hands
 * its agents, and the `surface_snapshot` of the list it started from (SPEC
 * §5.6, §11.4.2). */

import { requiredParamNames, USER_GOAL_PARAM_NAME } from "../integrations/mcp/llmText.js";
import { DEFAULT_INTENT_PARAM_MODE, withUserGoalJson } from "../integrations/mcp/schemaCompat.js";
import { assembleSurface, buildSeamAugmentations, surfaceHash, type ServerMeta } from "../integrations/mcp/surface.js";
import { printable, stderrLine } from "../warn.js";
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
    stderrLine(`baton: could not add user_goal to the tool list; serving it unchanged: ${printable(err)}`);
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
    stderrLine(`baton: surface snapshot capture failed: ${printable(err)}`);
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
  if (!isRecord(tool) || !isRecord(tool.inputSchema)) return tool;
  return { ...tool, inputSchema: withUserGoalJson(tool.inputSchema, DEFAULT_INTENT_PARAM_MODE, true) };
}
