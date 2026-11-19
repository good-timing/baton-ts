/** `serve()`: Baton around a vendor's own MCP dispatch function (SPEC §5.6).
 *
 * Each step here is pure and may throw; the client's `serve()` guards each
 * one, so a failure serves the vendor's own answer. */

import type { CallSettings, CaptureSettings, SettingsDocument } from "../integrations/mcp/captureSettings.js";
import {
  buildRefusalText,
  buildReportPointer,
  declaresParam,
  joined,
  mayDeclareParam,
  requiredParamNames,
  RETIRED_PARAM_NAMES,
  servedAgentText,
  unknownToolText,
  USER_GOAL_PARAM_NAME,
} from "../integrations/mcp/llmText.js";
import { INSTRUCTION_PIECES } from "../integrations/mcp/overlays.js";
import { batonParagraphs, toolsForCaller } from "../integrations/mcp/perCaller.js";
import { DEFAULT_INTENT_PARAM_MODE, goalTextsServed, takesUserGoalJson } from "../integrations/mcp/schemaCompat.js";
import { isThenable } from "../integrations/mcp/mcpTypes.js";
import { buildSeamAugmentations } from "../integrations/mcp/surface.js";
import { isRecord } from "../_object.js";
import { isBlank } from "../_text.js";
import { printable, stderrLine } from "../warn.js";
import type { AnnotateOptions, TraceOptions } from "./client.js";
import type { ReportTool } from "./reportTool.js";
import { serveTools, type Surface } from "./surface.js";

const INITIALIZE = "initialize";
export const TOOL_LIST = "tools/list";
export const TOOL_CALL = "tools/call";
/** A JSON-RPC `error` answer's `error_type`, as Python's mcp names that type. */
export const JSONRPC_ERROR_TYPE = "JSONRPCError";
export const REMEMBERED_TOOLS = 4096;

export interface Request {
  method: string;
  params: Record<string, unknown>;
}

/** The request `serve()` acts on; `null` sends `message` to dispatch as it is. */
export function readRequest(message: unknown): Request | null {
  if (!isRecord(message) || message.id === undefined || message.id === null) return null;
  const { method } = message;
  const params = message.params === undefined ? {} : message.params;
  if ((method !== INITIALIZE && method !== TOOL_LIST && method !== TOOL_CALL) || !isRecord(params)) return null;
  return { method, params };
}

type Disposition = "injected" | "native" | "may_take" | "unread";
type Dispositions = Record<string, Disposition>;

const OWN: ReadonlySet<Disposition | undefined> = new Set(["native", "may_take"]);
const KEPT: ReadonlySet<Disposition | undefined> = new Set(["native", "may_take", "unread"]);

/** How each of Baton's params stands on a tool with this vendor-true
 * `schema`: `"injected"`; `"native"` where the tool declares the name;
 * `"may_take"` where a schema Baton leaves alone may take it below its root;
 * `"unread"` for a schema Baton cannot read. All but `"injected"` are
 * forwarded rather than stripped. */
function goalDispositions(schema: unknown): Dispositions {
  if (schema === undefined || schema === null) return { [USER_GOAL_PARAM_NAME]: "injected" };
  const retired = Object.fromEntries(RETIRED_PARAM_NAMES.map((name) => [name, "native" as const]));
  if (!isRecord(schema) || !isRecord(schema.properties ?? {})) {
    return { ...retired, [USER_GOAL_PARAM_NAME]: "unread" };
  }
  if (!takesUserGoalJson(schema)) {
    // Its branches may declare a retired name, so one is kept.
    if (declaresParam(schema, USER_GOAL_PARAM_NAME)) return { ...retired, [USER_GOAL_PARAM_NAME]: "native" };
    return mayDeclareParam(schema, USER_GOAL_PARAM_NAME) ? { ...retired, [USER_GOAL_PARAM_NAME]: "may_take" } : retired;
  }
  const dispositions: Dispositions = {};
  for (const name of RETIRED_PARAM_NAMES) if (declaresParam(schema, name)) dispositions[name] = "native";
  dispositions[USER_GOAL_PARAM_NAME] = declaresParam(schema, USER_GOAL_PARAM_NAME) ? "native" : "injected";
  return dispositions;
}

const ownsUserGoal = (dispositions: Dispositions | undefined): boolean =>
  OWN.has(dispositions?.[USER_GOAL_PARAM_NAME]);

/** `user_goal` and the two retired names, in that order. */
type Goals = readonly [string | null, string | null, string | null];
const NO_GOALS: Goals = [null, null, null];

/** Take Baton's params off `args` in place and return their values; a name
 * whose disposition keeps it stays. With no dispositions (a tool not yet
 * seen) only `user_goal` is taken, since it is reserved. */
function popGoals(args: Record<string, unknown>, dispositions: Dispositions | undefined): Goals {
  const pop = (name: string): string | null => {
    if (!(name in args) || (dispositions !== undefined && KEPT.has(dispositions[name]))) return null;
    const value = args[name];
    delete args[name];
    return typeof value === "string" && !isBlank(value) ? value : null;
  };
  if (dispositions === undefined) return [pop(USER_GOAL_PARAM_NAME), null, null];
  return [pop(USER_GOAL_PARAM_NAME), pop(RETIRED_PARAM_NAMES[0]), pop(RETIRED_PARAM_NAMES[1])];
}

/** Each tool's dispositions and every tool's name. An entry that cannot be read is skipped. */
function knownTools(tools: readonly unknown[]): { dispositions: Map<string, Dispositions>; names: Set<string> } {
  const dispositions = new Map<string, Dispositions>();
  const names = new Set<string>();
  for (const tool of tools) {
    try {
      const name = isRecord(tool) ? tool.name : undefined;
      if (typeof name !== "string") continue;
      names.add(name);
      dispositions.set(name, goalDispositions((tool as { inputSchema?: unknown }).inputSchema));
    } catch {
      continue;
    }
  }
  return { dispositions, names };
}

type CallKind = "forward" | "report" | "refused" | "hidden";

export interface Call {
  name: string;
  /** Without Baton's params. */
  arguments: Record<string, unknown>;
  goals: Goals;
  /** What dispatch gets. */
  message: unknown;
  kind: CallKind;
  /** Baton's own answer, unless the call is forwarded. */
  answer?: Record<string, unknown>;
  /** `annotate()`'s options, for an accepted report. */
  report?: AnnotateOptions;
}

export function traceOptions(call: Call): TraceOptions {
  const [intent, expected, workflow] = call.goals;
  return {
    toolName: call.name,
    params: call.arguments,
    ...(intent === null ? {} : { intent }),
    ...(expected === null ? {} : { expectedOutcome: expected }),
    ...(workflow === null ? {} : { workflow }),
  };
}

interface Listed {
  answer: unknown;
  /** `null` for a paged list: one page is not the server's surface. */
  surface: Surface | null;
  seam: () => Record<string, unknown>;
  serverOverlay: string | null;
}

export interface Report {
  tool: ReportTool;
  vendorDisplayName: string;
}

export type VendorTools = readonly unknown[] | (() => readonly unknown[]);

interface ServerMeta {
  serverInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  instructions: string | null;
}

/** What one client's `serve()` remembers between requests: the vendor's
 * `initialize` values, and what it knows of the vendor's tools from the lists
 * it served and from `tools`. */
export class Serving {
  private serverMeta: ServerMeta = { serverInfo: null, capabilities: null, instructions: null };
  private readonly dispositions = new Map<string, Dispositions>();
  private vendorHasReportName = false;
  private warnedUnlisted = false;
  private unreadTools: VendorTools | undefined;

  constructor(
    private readonly report: Report | undefined,
    private readonly settings: CaptureSettings | undefined,
    tools?: VendorTools,
  ) {
    this.unreadTools = tools;
    // A given list is checked for the report tool's name now, so the clash is
    // reported at install. It is read in full at the first request, since the
    // vendor may add to it before then.
    if (report !== undefined && Array.isArray(tools)) {
      try {
        this.remember(new Map(), knownTools(tools).names);
      } catch {
        // The full read at the first request warns.
      }
    }
  }

  /** Learn the vendor's `tools` once per process. Never throws: without them,
   * a call to a tool not yet listed is served as on a cold process. */
  private readVendorTools(): void {
    const source = this.unreadTools;
    if (source === undefined) return;
    // Cleared first: a `tools` function that calls `serve()` would otherwise read itself.
    this.unreadTools = undefined;
    try {
      const tools: unknown = typeof source === "function" ? source() : source;
      if (isThenable(tools)) {
        throw new Error("tools must be an array or a plain function, not async");
      }
      if (!Array.isArray(tools)) throw new Error("tools gave something that is not an array");
      const known = knownTools(tools);
      this.remember(known.dispositions, known.names);
    } catch (err) {
      stderrLine(
        `baton: could not read the tools option; a call this process has not seen listed loses user_goal: ${printable(err)}`,
      );
    }
  }

  private remember(dispositions: ReadonlyMap<string, Dispositions>, names: ReadonlySet<string>): void {
    const fresh = [...dispositions.keys()].filter((name) => !this.dispositions.has(name)).length;
    if (this.dispositions.size + fresh > REMEMBERED_TOOLS) this.dispositions.clear();
    for (const [name, disposition] of dispositions) {
      if (!ownsUserGoal(this.dispositions.get(name))) this.dispositions.set(name, disposition);
    }
    const name = this.report?.tool.name;
    if (name !== undefined && names.has(name) && !this.vendorHasReportName) {
      this.vendorHasReportName = true;
      stderrLine(
        `baton: your tool ${JSON.stringify(name)} has the report tool's name, so Baton serves ` +
          "yours and no report tool. Set vendorDisplayName to give Baton's another name.",
      );
    }
  }

  /** The report tool, unless a vendor tool has its name. */
  private ours(): Report | undefined {
    return this.vendorHasReportName ? undefined : this.report;
  }

  private document(): SettingsDocument | null {
    return this.settings?.document ?? null;
  }

  initialized(answer: unknown): unknown {
    const result = resultOf(answer);
    if (result === null) return answer;
    const vendor = result.instructions;
    this.readVendorTools();
    this.serverMeta = {
      serverInfo: isRecord(result.serverInfo) ? result.serverInfo : null,
      capabilities: isRecord(result.capabilities) ? result.capabilities : null,
      instructions: typeof vendor === "string" ? vendor : null,
    };
    const nativeGoal = [...this.dispositions.values()].some((d) => d[USER_GOAL_PARAM_NAME] === "native");
    const report = this.ours();
    const document = this.document();
    const pointer =
      report === undefined
        ? undefined
        : buildReportPointer({ vendorDisplayName: report.vendorDisplayName, annotationToolName: report.tool.name });
    const shown = pointer !== undefined && (document === null || document.reportsOnForAnyone);
    const { ours } = batonParagraphs(shown ? pointer : undefined, document?.serverOverlay, !nativeGoal);
    return { ...(answer as Record<string, unknown>), result: { ...result, instructions: joined(vendor, ours) } };
  }

  listed(request: Request, answer: unknown, settings: CallSettings | undefined): Listed | null {
    const result = resultOf(answer);
    const tools = result?.tools;
    if (result === null || !Array.isArray(tools)) return null;
    this.readVendorTools();
    const { served, surface } = serveTools(tools as unknown[], this.serverMeta);
    const known = knownTools(tools);
    this.remember(known.dispositions, known.names);
    const report = this.ours();
    const firstPage = request.params.cursor === undefined || request.params.cursor === null;
    const out: unknown[] = [...served];
    if (report !== undefined && firstPage) {
      const { name, description, inputSchema } = report.tool;
      out.push({ name, description, inputSchema });
    }
    const overlay = this.document()?.serverOverlay;
    const overlayId = overlay?.id ?? null;
    const listed = toolsForCaller({ ...result, tools: out }, settings, {
      intentParamMode: DEFAULT_INTENT_PARAM_MODE,
      annotationToolName: report?.tool.name ?? "",
      injectsGoal: (name) => known.dispositions.get(name)?.[USER_GOAL_PARAM_NAME] === "injected",
    });
    const whole = firstPage && (result.nextCursor === undefined || result.nextCursor === null) ? surface : null;
    return {
      answer: { ...(answer as Record<string, unknown>), result: listed },
      surface: whole,
      seam: () => {
        const agentText = servedAgentText({
          reportNames:
            report === undefined
              ? undefined
              : { vendorDisplayName: report.vendorDisplayName, annotationToolName: report.tool.name },
          intentParamMode: DEFAULT_INTENT_PARAM_MODE,
          ...goalTextsServed(whole?.surface.tools ?? []),
          serverOverlay: overlay,
        });
        const seam = buildSeamAugmentations({
          injectedToolNames: report === undefined ? [] : [report.tool.name],
          intentParamNames: [USER_GOAL_PARAM_NAME],
          intentParamMode: DEFAULT_INTENT_PARAM_MODE,
          requiredParamNames: requiredParamNames(DEFAULT_INTENT_PARAM_MODE),
          instructionsSuffix: instructionsSuffix(agentText),
          agentText,
        });
        // SPEC §11.4.2: present only from a producer that applies overlays.
        if (this.settings !== undefined) seam.server_overlay = overlayId;
        return seam;
      },
      serverOverlay: overlayId,
    };
  }

  /** The plan for one `tools/call`; `null` sends it to dispatch untraced. */
  call(request: Request, message: Record<string, unknown>, settings: CallSettings | undefined): Call | null {
    const { name } = request.params;
    const args = request.params.arguments === undefined ? {} : request.params.arguments;
    if (typeof name !== "string" || !isRecord(args)) return null;
    this.readVendorTools();
    const dispositions = this.dispositions.get(name);
    const report = this.ours();
    if (report !== undefined && name === report.tool.name) return reportCall(report.tool, name, args, message, settings);
    if (dispositions === undefined && USER_GOAL_PARAM_NAME in args && !this.warnedUnlisted) {
      this.warnedUnlisted = true;
      stderrLine(
        `baton: removed user_goal from a call to ${JSON.stringify(name)}, a tool in no list this process has ` +
          "served or read from the tools option; a tool that declares its own user_goal keeps it only once " +
          "Baton has seen its schema",
      );
    }
    const stripped = { ...args };
    const goals = popGoals(stripped, dispositions);
    if (settings?.overlay?.hiddenTools.has(name)) return hidden(name, stripped, goals, message);
    const forwarded =
      Object.keys(stripped).length === Object.keys(args).length
        ? message
        : { ...message, params: { ...request.params, arguments: stripped } };
    return { name, arguments: stripped, goals, message: forwarded, kind: "forward" };
  }
}

function reportCall(
  tool: ReportTool,
  name: string,
  args: Record<string, unknown>,
  message: Record<string, unknown>,
  settings: CallSettings | undefined,
): Call {
  if (settings?.reportMode === "off") return hidden(name, { ...args }, NO_GOALS, message);
  const report = tool.annotateArgs(args);
  const body =
    report === null
      ? { ok: false, error: buildRefusalText({ annotationToolName: name, overlay: settings?.overlay }) }
      : { ok: true };
  return {
    name,
    arguments: { ...args },
    goals: NO_GOALS,
    message,
    kind: report === null ? "refused" : "report",
    answer: answerTo(message, { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body }),
    ...(report === null ? {} : { report }),
  };
}

/** The MCP SDK's own answer to a call for a tool it does not have. */
function hidden(name: string, args: Record<string, unknown>, goals: Goals, message: Record<string, unknown>): Call {
  const result = { content: [{ type: "text", text: unknownToolText(name) }], isError: true };
  return { name, arguments: args, goals, message, kind: "hidden", answer: answerTo(message, result) };
}

/** `message` without `user_goal`, for when Baton's plan failed: the list it
 * served may have added it. Never throws. */
export function withoutUserGoal(message: unknown): unknown {
  try {
    const params = (message as { params: Record<string, unknown> }).params;
    const args = params.arguments as Record<string, unknown>;
    if (!isRecord(args) || !(USER_GOAL_PARAM_NAME in args)) return message;
    const stripped = Object.fromEntries(Object.entries(args).filter(([key]) => key !== USER_GOAL_PARAM_NAME));
    return { ...(message as Record<string, unknown>), params: { ...params, arguments: stripped } };
  } catch {
    return message;
  }
}

export function jsonRpcError(answer: unknown): Record<string, unknown> | null {
  return isRecord(answer) && isRecord(answer.error) ? answer.error : null;
}

export function resultOf(answer: unknown): Record<string, unknown> | null {
  return isRecord(answer) && isRecord(answer.result) ? { ...answer.result } : null;
}

export function isToolErrorResult(result: Record<string, unknown> | null): boolean {
  return result !== null && Array.isArray(result.content) && result.isError === true;
}

function answerTo(message: Record<string, unknown>, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: message.jsonrpc ?? "2.0", id: message.id, result };
}

/** Whether Baton's text is in the served instructions; `null` when unknown. */
function instructionsSuffix(agentText: Record<string, unknown>): boolean | null {
  const pieces = INSTRUCTION_PIECES.filter((piece) => piece in agentText).map((piece) => agentText[piece]);
  return pieces.includes(null) ? null : pieces.length > 0;
}
