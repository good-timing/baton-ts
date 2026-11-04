/** The tool list and instructions under the Console's per-caller settings
 * (SPEC §2.6). The TypeScript half of Python's `_per_caller.py`. */

import { printable } from "../../warn.js";
import type { CaptureSettings } from "./captureSettings.js";
import { INTENT_INSTRUCTIONS, USER_GOAL_PARAM_NAME, buildUserGoalParamDescription } from "./llmText.js";
import type { ResolvedCaller } from "./principalResolution.js";
import type { IntentParamMode } from "./schemaCompat.js";

export interface PerCallerOptions {
  settings: CaptureSettings;
  intentParamMode: IntentParamMode;
  /** `""` under `reportMode: "off"`. */
  annotationToolName: string;
  /** Ours, with the report pointer. */
  instructions: string;
  writeInstructions: (ours: string) => void;
  /** Whether this tool's `user_goal` is Baton's; a tool's own is left alone. */
  injectsGoal: (toolName: string) => boolean;
}

/** Rewrites each `tools/list` result for its caller, and keeps the
 * instructions' report pointer while some audience has reports on. */
export class PerCallerSurface {
  private pointerOn = true;

  constructor(private readonly options: PerCallerOptions) {}

  /** Called at install and on every request; writes only when the report
   * pointer should change. */
  followSettings(): void {
    if (this.options.annotationToolName === "") return;
    try {
      const document = this.options.settings.document;
      const pointerOn = document === null || document.reportsOnForAnyone;
      if (pointerOn === this.pointerOn) return;
      this.options.writeInstructions(pointerOn ? this.options.instructions : INTENT_INSTRUCTIONS);
      this.pointerOn = pointerOn;
    } catch (err) {
      process.stderr.write(`baton: could not update the server instructions for new settings: ${printable(err)}\n`);
    }
  }

  /** `result` with the caller's goal and reports settings; as served on any failure. */
  toolsFor(result: unknown, caller: ResolvedCaller): unknown {
    const settings = caller.settings;
    if (settings === undefined) return result;
    const { intentParamMode, annotationToolName, injectsGoal } = this.options;
    const goal = settings.intentParamMode ?? intentParamMode;
    const hideReports = annotationToolName !== "" && settings.reportMode === "off";
    if (goal === intentParamMode && !hideReports) return result;
    try {
      const tools = (result as { tools?: unknown } | null | undefined)?.tools;
      if (!Array.isArray(tools)) return result;
      const served: unknown[] = [];
      for (const tool of tools) {
        const name = (tool as { name?: unknown } | null)?.name;
        if (hideReports && name === annotationToolName) continue;
        const rewrite = goal !== intentParamMode && typeof name === "string" && injectsGoal(name);
        served.push(rewrite ? withGoalMode(tool, goal) : tool);
      }
      return { ...(result as Record<string, unknown>), tools: served };
    } catch (err) {
      process.stderr.write(`baton: could not apply capture settings to the tool list: ${printable(err)}\n`);
      return result;
    }
  }
}

/** A copy of `tool` whose `user_goal` reads and is listed as `goal` says. */
function withGoalMode(tool: unknown, goal: IntentParamMode): unknown {
  const entry = tool as { inputSchema?: unknown };
  const schema = entry.inputSchema as { properties?: unknown; required?: unknown } | null | undefined;
  const properties = schema?.properties as Record<string, unknown> | null | undefined;
  const param = properties?.[USER_GOAL_PARAM_NAME];
  if (typeof param !== "object" || param === null) return tool;
  const others = Array.isArray(schema!.required)
    ? (schema!.required as unknown[]).filter((name) => name !== USER_GOAL_PARAM_NAME)
    : [];
  const required = goal === "required" ? [...others, USER_GOAL_PARAM_NAME] : others;
  return {
    ...entry,
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        [USER_GOAL_PARAM_NAME]: { ...param, description: buildUserGoalParamDescription({ intentParamMode: goal }) },
      },
      ...(required.length > 0 || Array.isArray(schema!.required) ? { required } : {}),
    },
  };
}
