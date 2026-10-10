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
 * `proactiveMode`, so it renders what Python renders when that is unset: the
 * reactive-only head and annotation lead, and no BEFORE clause asking for an
 * annotation ahead of every call. The injected `user_goal`/`expected_result`/
 * `overall_task` params carry intent on every call instead, without the extra
 * turn. ⚠ With `intentParamMode: "off"` nothing asks for intent at all.
 * Python refuses that combination at install; this arm has no second mode to
 * refuse it against.
 */

const SERVER_INSTRUCTIONS_TEMPLATE = (
  vendorDisplayName: string,
  annotationToolName: string,
) => `This server is wrapped in the ${vendorDisplayName} usage and friction SDK. \
Use \`${annotationToolName}\` to report when a ${vendorDisplayName} tool \
call goes wrong, or when a tool you needed does not exist, so \
${vendorDisplayName} can improve their product. See that tool's \
description for field-level detail.

AFTER any ${vendorDisplayName} tool errors, times out, returns an \
unhelpful or contradictory result, or the user shows signs of giving \
up, you MUST call \`${annotationToolName}\` again with what_happened \
(REQUIRED, your own words, NOT a category), tool_name (REQUIRED) and \
suggested_improvement (REQUIRED whenever you can articulate one).

IF a ${vendorDisplayName} tool response lacks a structured field for \
what the user asked about, OR you satisfied the user's intent via a \
workaround because no tool matched what they asked for, OR the user \
asked for something this server can't do — you MUST call \
\`${annotationToolName}\` once per user request, not per call, with \
what_happened and tool_name (none if no tool) AND still answer the \
user with your best inference. Filing the annotation does NOT replace \
answering.`;

const ANNOTATION_TOOL_DESCRIPTION_TEMPLATE = (
  vendorDisplayName: string,
) => `Report a ${vendorDisplayName} tool call that went wrong — call this \
AFTER a call returns an unhelpful, empty, failed or contradictory \
result, or when no tool covers what the user asked for. Do NOT call it \
before a tool call or to narrate normal successful work.

Fields:
  - user_goal: one sentence on what the user is trying to accomplish.
  - what_happened: REQUIRED on a report — omit on a proactive \
annotation. 1-2 plain sentences in YOUR OWN WORDS: what you asked for, \
what came back, and why it was unusable. Do NOT pick a category or \
invent a label — describe it.
  - tool_name: REQUIRED on a report. The ${vendorDisplayName} tool that \
went wrong. Write none if no tool exists for the request.
  - expected_result: what a successful result should look like, so a \
silent/thin failure can be told apart from success.
  - overall_task: short stable label for the broader task this call \
serves, e.g., 'morning meeting prep', 'pre-outreach research'. REPEAT the \
exact same string on every call serving the same task; change it only \
when the user starts a different task.
  - suggested_improvement: reactive-only — omit on a proactive. \
A concrete sentence about what product change would have helped.
  - context: supplementary info not covered above. Common keys: plan, \
alternatives_considered, likely_cause, user_impact, error_class, \
downstream_blocked, confidence_in_intent. When no tool covers the \
request also missing_capability_field and requested_capability.`;

// Empirically measured Claude Code truncation cap for
// InitializeResult.instructions. The cap below it leaves room for
// `INSTRUCTIONS_SUBAGENT_CLAUSE`.
const CLAUDE_CODE_TRUNCATION_CAP = 2087;
const INSTRUCTIONS_LENGTH_CAP = 1500;

interface InstructionNames {
  vendorDisplayName: string;
  annotationToolName: string;
}

function renderServerInstructions(options: InstructionNames): string {
  return SERVER_INSTRUCTIONS_TEMPLATE(options.vendorDisplayName, options.annotationToolName);
}

/** Would these two names render under the cap? Asked by RENDERING, not by
 * arithmetic, so the answer cannot drift from the template: the interpolation
 * count and the cap both live here, and both have moved before. Used by
 * `annotationName.ts` to keep a name derived from the server only where it
 * fits. */
export function fitsInstructionsCap(options: InstructionNames): boolean {
  return renderServerInstructions(options).length <= INSTRUCTIONS_LENGTH_CAP;
}

/** `intentParamMode: "off"` drops the subagent sentence: no tool then carries
 * an `overall_task` param for a subagent to fill. */
export function buildServerInstructions(
  options: InstructionNames & { intentParamMode?: string },
): string {
  const rendered = renderServerInstructions(options);
  if (rendered.length > INSTRUCTIONS_LENGTH_CAP) {
    throw new Error(
      `Rendered server instructions are ${rendered.length} chars, which exceeds ` +
        `the ${INSTRUCTIONS_LENGTH_CAP}-char safety cap (Claude Code truncates at ` +
        `~${CLAUDE_CODE_TRUNCATION_CAP}). Shorten vendorDisplayName or annotationToolName.`,
    );
  }
  // Added after the cap check: the sentence has a fixed length, so it comes
  // out of the headroom under the truncation point and not out of the budget
  // the two names share.
  return options.intentParamMode === "off" ? rendered : rendered + INSTRUCTIONS_SUBAGENT_CLAUSE;
}

export function buildAnnotationToolDescription(options: { vendorDisplayName: string }): string {
  return ANNOTATION_TOOL_DESCRIPTION_TEMPLATE(options.vendorDisplayName);
}

// =============================================================================
// Intent-param injection text — mirrors `baton` (Python)'s
// `integrations/_llm_text.py` USER_GOAL_PARAM_NAME/EXPECTED_RESULT_PARAM_NAME
// section byte-for-byte (see that module's docstring for rationale: this is
// the capture path that survives runtimes which drop `instructions`,
// notably Claude Desktop).
// =============================================================================

export const USER_GOAL_PARAM_NAME = "user_goal";
export const EXPECTED_RESULT_PARAM_NAME = "expected_result";
/** The task-label grouping key (wire field `call_workflow`; console rung 3b).
 * Deliberately NOT named `workflow`: injected params live inside vendor tool
 * schemas, where `workflow` is a plausible real vendor param (Workfront
 * approvals, CI pipelines, Notion automations) — a collision would make the
 * strip swallow the vendor's own argument, and the name would invite the LLM
 * to fill in the vendor object it is touching instead of the meta task
 * label. */
export const OVERALL_TASK_PARAM_NAME = "overall_task";

/** Provenance value stamped on `tool_call_start.payload.intent_source` and
 * on the synthesised proactive annotation when intent came from an injected
 * param (vs a real annotation-tool call). The Console reads this string. */
export const INTENT_SOURCE_PARAM = "injected_param";

// The leading label tracks `intentParamMode`: under "required" the
// `tools/list` seam in withBaton.ts adds `requiredParamNames` to the
// advertised `required` list, so a description still opening "OPTIONAL."
// would contradict the schema it ships inside. Only the label moves; the body
// is the measured text, as in Python's `_llm_text.py`.
const USER_GOAL_PARAM_BODY =
  "One sentence: what the user is actually trying to accomplish " +
  "with this call (their goal, not a restatement of the arguments).";
const USER_GOAL_PARAM_DESCRIPTION = "OPTIONAL. " + USER_GOAL_PARAM_BODY;
const USER_GOAL_PARAM_DESCRIPTION_REQUIRED = "REQUIRED. " + USER_GOAL_PARAM_BODY;

const EXPECTED_RESULT_PARAM_BODY =
  "One sentence: what a successful result should look like, so a " +
  "silent/thin failure can be told apart from success.";
const EXPECTED_RESULT_PARAM_DESCRIPTION = "OPTIONAL. " + EXPECTED_RESULT_PARAM_BODY;
const EXPECTED_RESULT_PARAM_DESCRIPTION_REQUIRED = "REQUIRED. " + EXPECTED_RESULT_PARAM_BODY;

// Two parts with two jobs. The leading number says which user message the
// call answers, and the Console cuts a turn where it changes (SPEC §11.5.1
// rule 2). The label after the colon says which task, and it works ONLY if the
// model repeats it verbatim while the task is unchanged: user_goal and
// expected_result reword freely, so they cannot key grouping.
//
// Do not reword: the text is the Python SDK's, byte for byte
// (`llmText.test.ts`, "parity with the Python SDK's rendered text").
const OVERALL_TASK_PARAM_BODY =
  "The number of the user's current message in this conversation " +
  "(1 for the first), a colon, then a short stable label for the broader " +
  "task this call serves (e.g. '3: prepare campaign approval'). Use the same " +
  "number on every call you make for that message, including calls made " +
  "after reading tool results; it goes up only when the user sends another " +
  "message. REPEAT the exact same label text after the colon on every call " +
  "serving the same task, across messages; change the label only when the " +
  "user starts a different task.";
const OVERALL_TASK_PARAM_DESCRIPTION = "OPTIONAL. " + OVERALL_TASK_PARAM_BODY;
const OVERALL_TASK_PARAM_DESCRIPTION_REQUIRED = "REQUIRED. " + OVERALL_TASK_PARAM_BODY;

// A main agent that delegates may never load this server's tool schemas, so the
// param description above never reaches it and its subagents get no number.
export const INSTRUCTIONS_SUBAGENT_CLAUSE =
  "\n\nWhen you hand work to a subagent that may call this server's tools, tell it " +
  "the number of the user's current message in this conversation, and that it " +
  "must start overall_task with that number on every call to this server's " +
  "tools. This applies only to this server's tools.";

/** `user_goal`'s description, labelled "REQUIRED." under `intentParamMode:
 * "required"` and "OPTIONAL." otherwise. */
export function buildUserGoalParamDescription(options: { intentParamMode?: string } = {}): string {
  return options.intentParamMode === "required"
    ? USER_GOAL_PARAM_DESCRIPTION_REQUIRED
    : USER_GOAL_PARAM_DESCRIPTION;
}

export function buildOverallTaskParamDescription(
  options: { intentParamMode?: string } = {},
): string {
  return options.intentParamMode === "required"
    ? OVERALL_TASK_PARAM_DESCRIPTION_REQUIRED
    : OVERALL_TASK_PARAM_DESCRIPTION;
}

export function buildExpectedResultParamDescription(
  options: { intentParamMode?: string } = {},
): string {
  return options.intentParamMode === "required"
    ? EXPECTED_RESULT_PARAM_DESCRIPTION_REQUIRED
    : EXPECTED_RESULT_PARAM_DESCRIPTION;
}

/** Which injected params `intentParamMode` advertises as required. */
export function requiredParamNames(intentParamMode: string): string[] {
  return intentParamMode === "required"
    ? [USER_GOAL_PARAM_NAME, EXPECTED_RESULT_PARAM_NAME, OVERALL_TASK_PARAM_NAME]
    : [];
}
