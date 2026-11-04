/** The annotation tool as data, for a vendor offering it through its own API (SPEC §5.6). */

import { isRecord } from "../_object.js";
import {
  ANNOTATION_INPUT_SHAPE,
  isReport,
  TOOL_NAME_PARAM_NAME,
} from "../integrations/mcp/annotation.js";
import {
  toolNameForDisplayName,
  validateAnnotationToolName,
} from "../integrations/mcp/annotationName.js";
import {
  buildAnnotationToolDescription,
  buildRefusalText,
  buildServerInstructions,
  fitsInstructionsCap,
  USER_GOAL_PARAM_NAME,
} from "../integrations/mcp/llmText.js";
import { toolInputJsonSchema } from "../integrations/mcp/schemaCompat.js";
import type { AnnotateOptions } from "./client.js";

/** The tool an MCP adapter registers under `reportMode: "on"`. */
export interface ReportTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** The report pointer and `INTENT_INSTRUCTIONS`, for a vendor serving MCP itself. */
  readonly instructions: string;
  /** What to answer when `annotateArgs` returns `null`. */
  readonly refusal: string;
  /** The `annotate()` options for this tool's `args`, or `null` when there is
   * no `what_happened`: answer `refusal` and send nothing. */
  annotateArgs(args: Readonly<Record<string, unknown>>): AnnotateOptions | null;
}

function inputSchema(): Record<string, unknown> {
  const schema = toolInputJsonSchema(ANNOTATION_INPUT_SHAPE);
  delete schema.$schema;
  return { ...schema, required: [...(schema.required as string[]), TOOL_NAME_PARAM_NAME] };
}

const nonEmptyText = (value: unknown): value is string => typeof value === "string" && value !== "";

const nonEmptyObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length > 0;

function annotateArgs(args: Readonly<Record<string, unknown>>): AnnotateOptions | null {
  const whatHappened = args.what_happened;
  if (!isReport(whatHappened)) return null;
  const options: AnnotateOptions = { whatHappened };
  // Sent as written, "" included: SPEC §5.1.1 gives tool_name three states.
  const toolName = args[TOOL_NAME_PARAM_NAME];
  if (typeof toolName === "string") options.toolName = toolName;
  const intent = args[USER_GOAL_PARAM_NAME];
  if (nonEmptyText(intent)) options.intent = intent;
  if (nonEmptyText(args.suggested_improvement)) {
    options.suggestedImprovement = args.suggested_improvement;
  }
  if (nonEmptyObject(args.context)) options.context = args.context;
  return options;
}

/** The annotation tool an adapter registers on a server named
 * `vendorDisplayName`. `name` overrides the name made from it. */
export function reportTool(options: { vendorDisplayName: string; name?: string }): ReportTool {
  const { vendorDisplayName } = options;
  const derived = options.name ?? toolNameForDisplayName(vendorDisplayName);
  if (derived === undefined) {
    throw new Error(
      `vendorDisplayName ${JSON.stringify(vendorDisplayName)} gives no usable tool name, ` +
        "or one too long for the instructions. Pass name.",
    );
  }
  const name = validateAnnotationToolName(derived);
  if (!fitsInstructionsCap({ vendorDisplayName, annotationToolName: name })) {
    throw new Error(
      `vendorDisplayName and name ${JSON.stringify(name)} are too long together for ` +
        "the instructions. Shorten one of them.",
    );
  }
  return {
    name,
    description: buildAnnotationToolDescription({ vendorDisplayName }),
    inputSchema: inputSchema(),
    instructions: buildServerInstructions({ vendorDisplayName, annotationToolName: name }),
    refusal: buildRefusalText({ annotationToolName: name }),
    annotateArgs,
  };
}
