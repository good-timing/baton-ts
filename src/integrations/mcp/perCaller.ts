/** The tool list and instructions under the Console's per-caller settings
 * (SPEC §2.6). The TypeScript half of Python's `_per_caller.py`. */

import { isRecord } from "../../_object.js";
import { stripWhiteSpaceEnd } from "../../_text.js";
import { printable, stderrLine } from "../../warn.js";
import type { CallSettings, CaptureSettings, SettingsDocument } from "./captureSettings.js";
import { INTENT_INSTRUCTIONS, USER_GOAL_PARAM_NAME, buildUserGoalParamDescription, declaresParam } from "./llmText.js";
import { type Action, type Overlay, changedText, overlaid, warnSkipped } from "./overlays.js";
import type { ResolvedCaller } from "./principalResolution.js";
import type { IntentParamMode } from "./schemaCompat.js";

export interface PerCallerOptions {
  settings: CaptureSettings;
  intentParamMode: IntentParamMode;
  /** `""` under `reportMode: "off"`. */
  annotationToolName: string;
  /** The report pointer paragraph; `undefined` with no report tool. */
  pointer: () => string | undefined;
  /** `subagent` is the subagent sentence `ours` ends with, if it does. */
  writeInstructions: (ours: string, subagent: string | null) => void;
  /** False once a tool declares its own `user_goal`. */
  subagentLine: () => boolean;
  /** Whether this tool's `user_goal` is Baton's; a tool's own is left alone. */
  injectsGoal: (toolName: string) => boolean;
}

const UNREAD = Symbol("unread");

/** Rewrites each `tools/list` result for its caller, and keeps the
 * instructions' report pointer while some audience has reports on, with the
 * server overlay applied. */
export class PerCallerSurface {
  private document: SettingsDocument | null | typeof UNREAD = UNREAD;
  private served: string | null = null;
  serverOverlay: Overlay | undefined;

  constructor(private readonly options: PerCallerOptions) {}

  /** Called at install and on every request; writes only when the report
   * pointer or the server overlay should change. */
  followSettings(): void {
    try {
      const document = this.options.settings.document;
      if (document === this.document) return;
      const overlay = document?.serverOverlay;
      const pointer = this.options.pointer();
      const pointerOn = pointer !== undefined && (document === null || document.reportsOnForAnyone);
      const served = JSON.stringify([pointerOn, overlay?.id ?? null]);
      if (served !== this.served) {
        const { ours, subagent } = batonParagraphs(pointerOn ? pointer : undefined, overlay, this.options.subagentLine());
        this.options.writeInstructions(ours, subagent);
        this.served = served;
        this.serverOverlay = overlay;
      }
      this.document = document;
    } catch (err) {
      stderrLine(`baton: could not update the server instructions for new settings: ${printable(err)}`);
    }
  }

  /** `followSettings` after the report pointer changed outside the settings. */
  refresh(): void {
    this.document = UNREAD;
    this.served = null;
    this.followSettings();
  }

  /** `result` with the caller's goal, reports and overlay; as served on any failure. */
  toolsFor(result: unknown, caller: ResolvedCaller): unknown {
    return toolsForCaller(result, caller.settings, this.options);
  }
}

/** `result` with the goal, reports and overlay of `settings`; as served on any failure. */
export function toolsForCaller(
  result: unknown,
  settings: CallSettings | undefined,
  options: Pick<PerCallerOptions, "intentParamMode" | "annotationToolName" | "injectsGoal">,
): unknown {
  if (settings === undefined) return result;
  const { intentParamMode, annotationToolName, injectsGoal } = options;
  const goal = settings.intentParamMode ?? intentParamMode;
  const hideReports = annotationToolName !== "" && settings.reportMode === "off";
  const overlay = settings.overlay;
  if (goal === intentParamMode && !hideReports && overlay === undefined) return result;
  try {
    const tools = (result as { tools?: unknown } | null | undefined)?.tools;
    if (!Array.isArray(tools)) return result;
    const served: unknown[] = [];
    const injected: boolean[] = [];
    for (const tool of tools) {
      const name = (tool as { name?: unknown } | null)?.name;
      if (hideReports && name === annotationToolName) continue;
      const ours =
        typeof name === "string" &&
        injectsGoal(name) &&
        declaresParam((tool as { inputSchema?: unknown } | null)?.inputSchema, USER_GOAL_PARAM_NAME);
      served.push(goal !== intentParamMode && ours ? withGoalMode(tool, goal) : tool);
      injected.push(ours);
    }
    const rewritten =
      overlay === undefined ? served : withOverlay(served, injected, overlay, annotationToolName || undefined);
    return { ...(result as Record<string, unknown>), tools: rewritten };
  } catch (err) {
    stderrLine(`baton: could not apply capture settings to the tool list: ${printable(err)}`);
    return result;
  }
}

/** Baton's paragraphs of the instructions, and the subagent sentence they end with if any. */
export function batonParagraphs(
  pointer: string | undefined,
  overlay: Overlay | undefined,
  subagentLine: boolean,
): { ours: string; subagent: string | null } {
  const parts = overlay?.instructionAppends() ?? [];
  if (pointer !== undefined) parts.push(overlaid(pointer, overlay, "instructions.report_pointer"));
  if (subagentLine) parts.push(overlaid(INTENT_INSTRUCTIONS, overlay, "instructions.subagent"));
  // SPEC §2.6's append rule: each paragraph loses the white space at its end.
  const kept = parts.map(stripWhiteSpaceEnd);
  return { ours: kept.filter((part) => part).join("\n\n"), subagent: (subagentLine && kept.at(-1)) || null };
}

type Tool = Record<string, unknown>;
type Schema = { properties?: unknown; required?: unknown } & Record<string, unknown>;

/** SPEC §2.6: the audience overlay's actions on the tool list, in order.
 * `injected` says which tools carry Baton's `user_goal`. */
function withOverlay(
  tools: unknown[],
  injected: readonly boolean[],
  overlay: Overlay,
  reportTool: string | undefined,
): unknown[] {
  const position = new Map<unknown, number>();
  tools.forEach((tool, i) => position.set((tool as { name?: unknown } | null)?.name, i));
  const hidden = new Set<number>();
  for (const action of overlay.actions) {
    if (action.tool === undefined) continue;
    const i = position.get(action.tool);
    if (i === undefined) {
      warnSkipped(overlay.id, action.index, `no tool is named ${JSON.stringify(action.tool)}`);
    } else if (action.tool === reportTool) {
      warnSkipped(overlay.id, action.index, "the report tool takes agent_text targets only");
    } else if (action.param === undefined && action.change === "remove") {
      hidden.add(i);
    } else if (action.param === undefined) {
      tools[i] = withDescription(tools[i] as Tool, [action]);
    } else {
      const reason = paramChange(tools, i, action, injected[i]!);
      if (reason !== undefined) warnSkipped(overlay.id, action.index, reason);
    }
  }
  const goalActions = overlay.pieceActions("goal_param.description");
  if (goalActions.length > 0) {
    injected.forEach((ours, i) => {
      if (ours) describeParam(tools, i, USER_GOAL_PARAM_NAME, goalActions);
    });
  }
  const reportActions = overlay.pieceActions("report_tool.description");
  const reportAt = reportTool === undefined ? undefined : position.get(reportTool);
  if (reportActions.length > 0 && reportAt !== undefined) {
    tools[reportAt] = withDescription(tools[reportAt] as Tool, reportActions);
  }
  return tools.filter((_, i) => !hidden.has(i));
}

function withDescription(tool: Tool, actions: readonly Action[]): Tool {
  const description = typeof tool.description === "string" ? tool.description : undefined;
  return { ...tool, description: changedText(description, actions).text };
}

/** Apply one param action to `tools[i]`; why it was skipped, else `undefined`. */
function paramChange(tools: unknown[], i: number, action: Action, injected: boolean): string | undefined {
  const param = action.param!;
  const tool = tools[i] as Tool;
  const schema = tool.inputSchema as Schema | undefined;
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
  if (properties === undefined || !Object.hasOwn(properties, param)) {
    return `${JSON.stringify(action.tool)} has no param ${JSON.stringify(param)}`;
  }
  if (injected && param === USER_GOAL_PARAM_NAME) return "Baton's user_goal takes the goal_param.description target";
  const required = Array.isArray(schema!.required) ? (schema!.required as unknown[]) : [];
  if (action.change === "remove") {
    if (required.includes(param)) return `${JSON.stringify(action.tool)} requires ${JSON.stringify(param)}`;
    const kept = Object.fromEntries(Object.entries(properties).filter(([name]) => name !== param));
    tools[i] = { ...tool, inputSchema: { ...schema, properties: kept } };
  } else if (action.change === "required") {
    if (!required.includes(param)) tools[i] = { ...tool, inputSchema: { ...schema, required: [...required, param] } };
  } else {
    describeParam(tools, i, param, [action]);
  }
  return undefined;
}

function describeParam(tools: unknown[], i: number, param: string, actions: readonly Action[]): void {
  const tool = tools[i] as Tool;
  const schema = tool.inputSchema as Schema;
  const properties = schema.properties as Record<string, unknown>;
  const described = isRecord(properties[param]) ? properties[param] : {};
  const current = typeof described.description === "string" ? described.description : undefined;
  const description = changedText(current, actions).text;
  tools[i] = {
    ...tool,
    inputSchema: { ...schema, properties: { ...properties, [param]: { ...described, description } } },
  };
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
