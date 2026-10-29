/**
 * Shared LLM-facing text: server instructions + annotation tool
 * description. Byte-for-byte port of `baton` (Python)'s
 * `integrations/_llm_text.py` template strings; see that module's
 * docstring for the full rationale (split of responsibility under Claude
 * Code's instructions-truncation cap, the mechanical-trigger design). Kept
 * in sync by hand, as there is no cross-language codegen for prose, and
 * checked: `test/integrations/mcp/llmTextVectors.json` is Python's own
 * rendering, compared string-for-string.
 *
 * **Python's DEFAULT text, `proactive_mode="off"`.** This arm has no
 * `proactiveMode`, so under `reportMode: "on"` it renders what Python renders
 * when that is unset: the reactive-only head and annotation lead, and no
 * BEFORE clause asking for an annotation ahead of every call.
 */

const SERVER_INSTRUCTIONS_TEMPLATE = (
  vendorDisplayName: string,
  annotationToolName: string,
  recovery: string,
) => `This server is wrapped in the ${vendorDisplayName} usage and friction SDK. \
Use \`${annotationToolName}\` to report when a ${vendorDisplayName} tool \
call goes wrong, or when a tool you needed does not exist, so \
${vendorDisplayName} can improve their product. See that tool's \
description for field-level detail.

AFTER any ${vendorDisplayName} tool errors, times out, returns an \
unhelpful or contradictory result, or the user shows signs of giving \
up, you MUST call \`${annotationToolName}\` with what_happened \
(REQUIRED, your own words, NOT a category), tool_name (REQUIRED) and \
suggested_improvement (REQUIRED whenever you can articulate one).${recovery}

IF a ${vendorDisplayName} tool response lacks a structured field for \
what the user asked about, OR you satisfied the user's intent via a \
workaround because no tool matched what they asked for, OR the user \
asked for something this server can't do — you MUST call \
\`${annotationToolName}\` once per user request, not per call, with \
what_happened and tool_name (none if no tool) AND still answer the \
user with your best inference. Filing the annotation does NOT replace \
answering.`;

// Without it an agent can file the report and stop the user's task.
export const INSTRUCTIONS_RECOVERY_SENTENCE =
  " Then keep going: work out why the call failed, fix the input, and try " +
  "again. Do not repeat the same failing call. Reporting is not a " +
  "substitute for recovering.";

const ANNOTATION_TOOL_DESCRIPTION_TEMPLATE = (
  vendorDisplayName: string,
) => `Report a ${vendorDisplayName} tool call that went wrong — call this \
AFTER a call returns an unhelpful, empty, failed or contradictory \
result, or when no tool covers what the user asked for. Do NOT call it \
before a tool call or to narrate normal successful work.

Fields:
  - user_goal: ${USER_GOAL_PARAM_BODY}
  - what_happened: REQUIRED on a report. \
1-2 plain sentences in YOUR OWN WORDS: what you asked for, \
what came back, and why it was unusable. Do NOT pick a category or \
invent a label — describe it.
  - tool_name: REQUIRED on a report. The ${vendorDisplayName} tool that \
went wrong. Write none if no tool exists for the request.
  - suggested_improvement: A concrete sentence about what product change \
would have helped.
  - context: supplementary info not covered above. Common keys: plan, \
alternatives_considered, likely_cause, user_impact, error_class, \
downstream_blocked, confidence_in_intent. When no tool covers the \
request also missing_capability_field and requested_capability.`;

// Empirically measured Claude Code truncation cap for
// InitializeResult.instructions. The cap below it leaves room for the fixed
// recovery and subagent sentences.
const CLAUDE_CODE_TRUNCATION_CAP = 2087;
const INSTRUCTIONS_LENGTH_CAP = 1500;

interface InstructionNames {
  vendorDisplayName: string;
  annotationToolName: string;
}

function renderServerInstructions(options: InstructionNames, recovery = ""): string {
  return SERVER_INSTRUCTIONS_TEMPLATE(options.vendorDisplayName, options.annotationToolName, recovery);
}

/** Would these two names render under the cap? Asked by RENDERING, not by
 * arithmetic, so the answer cannot drift from the template: the interpolation
 * count and the cap both live here, and both have moved before. Used by
 * `annotationName.ts` to keep a name derived from the server only where it
 * fits. */
export function fitsInstructionsCap(options: InstructionNames): boolean {
  return renderServerInstructions(options).length <= INSTRUCTIONS_LENGTH_CAP;
}

export function buildServerInstructions(options: InstructionNames): string {
  const budgeted = renderServerInstructions(options).length;
  if (budgeted > INSTRUCTIONS_LENGTH_CAP) {
    throw new Error(
      `Rendered server instructions are ${budgeted} chars, which exceeds ` +
        `the ${INSTRUCTIONS_LENGTH_CAP}-char safety cap (Claude Code truncates at ` +
        `~${CLAUDE_CODE_TRUNCATION_CAP}). Shorten vendorDisplayName or annotationToolName.`,
    );
  }
  // The fixed sentences have no names in them, so they come out of the
  // headroom under the truncation cap, not out of the budget the names share.
  const rendered = renderServerInstructions(options, INSTRUCTIONS_RECOVERY_SENTENCE);
  return rendered + INSTRUCTIONS_SUBAGENT_CLAUSE;
}

export function buildAnnotationToolDescription(options: { vendorDisplayName: string }): string {
  return ANNOTATION_TOOL_DESCRIPTION_TEMPLATE(options.vendorDisplayName);
}

// =============================================================================
// Intent-param injection text — mirrors `baton` (Python)'s
// `integrations/_llm_text.py` byte-for-byte. This is the capture path that
// survives runtimes which drop `instructions`, notably Claude Desktop.
// =============================================================================

export const USER_GOAL_PARAM_NAME = "user_goal";

// Not injected. A client with an old tool list may still send them, and
// `overall_task` carries the turn number the Console falls back to.
export const EXPECTED_RESULT_PARAM_NAME = "expected_result";
export const OVERALL_TASK_PARAM_NAME = "overall_task";
export const RETIRED_PARAM_NAMES = [EXPECTED_RESULT_PARAM_NAME, OVERALL_TASK_PARAM_NAME] as const;

/** Provenance value stamped on `tool_call_start.payload.intent_source` when
 * intent came from an injected param. The Console reads this string. */
export const INTENT_SOURCE_PARAM = "injected_param";

/** `intent_source` when the vendor's code passed intent to `client.trace()`. */
export const INTENT_SOURCE_LIBRARY = "library_arg";

// The leading number says which user message the call answers, and the
// Console cuts a turn where it changes (SPEC §11.5.1 rule 2). The Console
// splits the rest on "; success is".
//
// Do not reword: the text is the Python SDK's, byte for byte
// (`llmText.test.ts`, "parity with the Python SDK's rendered text"). Only the
// leading label tracks `intentParamMode`, so it agrees with the `required`
// list the `tools/list` seam advertises.
const USER_GOAL_PARAM_BODY =
  "Write it as '<n>: <what this call is for>; success is <what its result " +
  "should show>'. n is the number of the user's current message in this " +
  "conversation (1 for the first). Use the same number on every call you make " +
  "for that message, including calls made after reading tool results; it goes " +
  "up only when the user sends another message.";
const USER_GOAL_PARAM_DESCRIPTION = "OPTIONAL. " + USER_GOAL_PARAM_BODY;
const USER_GOAL_PARAM_DESCRIPTION_REQUIRED = "REQUIRED. " + USER_GOAL_PARAM_BODY;

// A main agent that delegates may never load this server's tool schemas, so the
// param description above never reaches it and its subagents get no number.
export const INSTRUCTIONS_SUBAGENT_CLAUSE =
  "\n\nWhen you hand work to a subagent that may call this server's tools, tell it " +
  "the number of the user's current message in this conversation, and that it " +
  "must start user_goal with that number on every call to this server's " +
  "tools. This applies only to this server's tools.";

/** The server instructions a vendor serving MCP itself puts in its
 * `initialize` result beside `user_goal` (SPEC §5.6), and all of Baton's
 * instructions under `reportMode: "off"`. */
export const INTENT_INSTRUCTIONS = INSTRUCTIONS_SUBAGENT_CLAUSE.trim();

/** `user_goal`'s description, labelled "REQUIRED." under `intentParamMode:
 * "required"` and "OPTIONAL." otherwise. */
export function buildUserGoalParamDescription(options: { intentParamMode?: string } = {}): string {
  return options.intentParamMode === "required"
    ? USER_GOAL_PARAM_DESCRIPTION_REQUIRED
    : USER_GOAL_PARAM_DESCRIPTION;
}

/** Which injected params `intentParamMode` advertises as required. */
export function requiredParamNames(intentParamMode: string): string[] {
  return intentParamMode === "required" ? [USER_GOAL_PARAM_NAME] : [];
}

/** Whether a tool's vendor-true JSON `inputSchema` declares `name` itself. */
export function declaresParam(schema: unknown, name: string): boolean {
  const props = (schema as { properties?: unknown } | null | undefined)?.properties;
  return typeof props === "object" && props !== null && name in props;
}

/** Whether Baton's text is in the served instructions. Without the annotation
 * tool it is only the subagent sentence, which a tool declaring its own
 * `user_goal` removes. */
export function instructionsSuffixServed(annotationToolName: string, served: unknown): boolean {
  if (annotationToolName) return true;
  return typeof served === "string" && served.includes(INTENT_INSTRUCTIONS);
}

/** One injected param, for a vendor adding it to its own API (SPEC §5.6).
 * `description` is the text an agent reads on an MCP server, without the
 * leading "OPTIONAL." / "REQUIRED." label: whether the vendor's API requires
 * it is the vendor's call. `traceOption` is the `client.trace()` option the
 * agent's answer goes to. */
export interface IntentParam {
  readonly name: string;
  readonly description: string;
  readonly traceOption: "intent";
}

export const INTENT_PARAMS: readonly IntentParam[] = Object.freeze([
  Object.freeze({ name: USER_GOAL_PARAM_NAME, description: USER_GOAL_PARAM_BODY, traceOption: "intent" }),
]);

const VENDOR_INSTRUCTIONS = Symbol("batonVendorInstructions");
// Where our paragraph begins: the reports head, or the whole text under
// `reportMode: "off"`.
const OURS_STARTS = ["This server is wrapped in the ", INTENT_INSTRUCTIONS];

interface InstructionsHolder {
  _instructions?: string | undefined;
  [VENDOR_INSTRUCTIONS]?: string | undefined;
}

function endsInOurs(current: unknown, vendor: unknown): boolean {
  if (typeof current !== "string") return false;
  const prefix = typeof vendor === "string" && vendor.trim() ? `${vendor}\n\n` : "";
  return OURS_STARTS.some((start) => current.startsWith(prefix + start));
}

/** SPEC §5.1.2: the vendor's own instructions first, ours below them.
 *
 * The runtime cuts at `CLAUDE_CODE_TRUNCATION_CAP` from the end, so the order
 * decides whose text is lost. The vendor's text is remembered on the server, so
 * a second install replaces our paragraph rather than appending another; text
 * the vendor set in between replaces what was remembered. */
export function withVendorInstructions(
  server: object,
  ours: string,
  warn: (message: string) => void = (message) => process.stderr.write(message),
): string {
  const holder = server as InstructionsHolder;
  const current = holder._instructions;
  let vendor = VENDOR_INSTRUCTIONS in holder ? holder[VENDOR_INSTRUCTIONS] : current;
  if (!endsInOurs(current, vendor)) {
    vendor = current;
    holder[VENDOR_INSTRUCTIONS] = vendor;
  }
  if (typeof vendor !== "string" || !vendor.trim()) return ours;
  const combined = `${vendor}\n\n${ours}`;
  if (combined.length > CLAUDE_CODE_TRUNCATION_CAP) {
    warn(
      `baton: the server instructions are ${combined.length} chars (yours ${vendor.length}, ` +
        `Baton's ${ours.length}); Claude Code cuts them at ~${CLAUDE_CODE_TRUNCATION_CAP}, ` +
        "so the end of Baton's text is lost there\n",
    );
  }
  return combined;
}
