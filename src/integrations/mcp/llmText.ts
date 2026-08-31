/**
 * Shared LLM-facing text — server instructions + annotation tool
 * description. Byte-for-byte port of `baton` (Python)'s
 * `integrations/_llm_text.py` template strings; see that module's
 * docstring for the full rationale (split of responsibility under Claude
 * Code's instructions-truncation cap, the mechanical-trigger design). Kept
 * in sync by hand — there is no cross-language codegen for prose.
 */

const SERVER_INSTRUCTIONS_TEMPLATE = (
  vendorDisplayName: string,
  annotationToolName: string,
) => `This server is wrapped in the ${vendorDisplayName} support-signal SDK. \
Use \`${annotationToolName}\` to record what the user is trying to do and \
how each ${vendorDisplayName} tool call went. See that tool's \
description for field-level detail.

BEFORE invoking any ${vendorDisplayName} tool, you MUST call \
\`${annotationToolName}\` with user_goal (REQUIRED), expected_result \
(REQUIRED), and overall_task (REQUIRED when the request fits a \
recognizable \
broader task, e.g., 'morning meeting prep', 'pre-outreach research').

AFTER any ${vendorDisplayName} tool errors, times out, returns an \
unhelpful or contradictory result, or the user shows signs of giving \
up, you MUST call \`${annotationToolName}\` again with signal_type \
(REQUIRED) — one of failure, retry_loop, dead_end, parameter_confusion, \
slow_performance, abandonment, feature_gap, other — and \
suggested_improvement (REQUIRED whenever you can articulate one).

IF a ${vendorDisplayName} tool response lacks a structured field for \
what the user asked about, OR you satisfied the user's intent via a \
workaround because no tool matched what they asked for, OR the user \
asked for something this server can't do — you MUST call \
\`${annotationToolName}\` with signal_type='feature_gap' AND still \
answer the user with your best inference. Filing the annotation does \
NOT replace answering.`;

const ANNOTATION_TOOL_DESCRIPTION_TEMPLATE = (
  vendorDisplayName: string,
) => `Record structured signal about a ${vendorDisplayName} tool call — \
what the user is trying to do, and how it went. Populate proactively \
before the call (user_goal + expected_result + overall_task) and reactively \
after if the result was unhelpful (signal_type + suggested_improvement).

Fields:
  - user_goal: one sentence on what the user is trying to accomplish.
  - expected_result: what a successful result should look like, so a \
silent/thin failure can be told apart from success.
  - overall_task: short stable label for the broader task this call \
serves, e.g., 'morning meeting prep', 'pre-outreach research', 'personal \
scheduling'. REPEAT the exact same string on every call serving the same \
task; change it only when the user starts a different task. Skip when the \
call doesn't fit a recognizable broader task.
  - signal_type: reactive-only — omit on a proactive annotation. \
Set only once a tool call has returned an unhelpful result. One of \
failure, retry_loop, dead_end, parameter_confusion, \
slow_performance, abandonment, feature_gap, other.
  - suggested_improvement: reactive-only — omit on a proactive. \
A concrete sentence about what product change would have helped.
  - context: supplementary info not covered above. Common keys: plan, \
alternatives_considered, likely_cause, user_impact, error_class, \
downstream_blocked, confidence_in_intent. For signal_type='feature_gap' \
also missing_capability_field and requested_capability.`;

// Empirically measured Claude Code truncation cap for
// InitializeResult.instructions. Reserve headroom for vendor extensions
// composed on top.
const CLAUDE_CODE_TRUNCATION_CAP = 2087;
const INSTRUCTIONS_LENGTH_CAP = 1500;

// Canonical signal_type values per SPEC §3.1. Stable and additive-only
// until v1.0 (SPEC §13). The annotation tool's inputSchema enum and the
// instructions text reference the same eight values.
export const SIGNAL_TYPES = [
  "failure",
  "retry_loop",
  "dead_end",
  "parameter_confusion",
  "slow_performance",
  "abandonment",
  "feature_gap",
  "other",
] as const;

export function buildServerInstructions(options: {
  vendorDisplayName: string;
  annotationToolName: string;
}): string {
  const rendered = SERVER_INSTRUCTIONS_TEMPLATE(
    options.vendorDisplayName,
    options.annotationToolName,
  );
  if (rendered.length > INSTRUCTIONS_LENGTH_CAP) {
    throw new Error(
      `Rendered server instructions are ${rendered.length} chars, which exceeds ` +
        `the ${INSTRUCTIONS_LENGTH_CAP}-char safety cap (Claude Code truncates at ` +
        `~${CLAUDE_CODE_TRUNCATION_CAP}). Shorten vendorDisplayName or annotationToolName.`,
    );
  }
  return rendered;
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

const USER_GOAL_PARAM_DESCRIPTION =
  "OPTIONAL. One sentence: what the user is actually trying to accomplish " +
  "with this call (their goal, not a restatement of the arguments).";

const EXPECTED_RESULT_PARAM_DESCRIPTION =
  "OPTIONAL. One sentence: what a successful result should look like, so a " +
  "silent/thin failure can be told apart from success.";

// The stability contract is the load-bearing design element: user_goal/
// expected_result are call-scoped diagnostics that reword freely, so they
// cannot key grouping; this param works ONLY if the model repeats the label
// verbatim while the task is unchanged (measured 2026-08-10: without the
// contract, 80% of adjacent same-task calls reword their goal text).
//
// Granularity is a KNOWN, MEASURED weakness of this text, kept anyway because
// the obvious fix is worse. Do not reword without scoring against both corpora
// in baton-internal `spikes/overall_task_a5/` (40 paired live-agent sessions,
// 2026-08-11, one build per run).
//
// What this text gets wrong: when the user switches topic WITHOUT announcing
// it, agents carry the first task's label onto everything after it — one
// session labelled a rice lookup, a chickpea restock and a waste check all
// "cook dal tonight". Boundary detection 0.700 on cue-free multi-task scripts
// (1.000 when the user says "Different thing:", which is why an earlier run
// missed this entirely).
//
// What it gets right, and why it stays: it never splits a task that should
// stay whole — 20/20 same-task pairs held the label verbatim across both
// corpora. The candidate rewording ("the specific task the user is working on
// right now — not the overall theme of the conversation") fixes the boundary
// problem completely (1.000) but relabels *within* a single task, describing
// successive steps of one goal as different tasks; it scored 0.200 then 0.400
// over-split on identical scripts, and produced an A → B → A label that a
// merge-only, adjacency-based consumer resolves as three tasks instead of one.
// The gain (+0.300 boundary) is smaller than the cost (0.400 over-split), and
// shattering is the failure mode that destroys downstream trust, so the trade
// goes this way.
//
// The open target for any v3 is therefore specific: the candidate's boundary
// behaviour with this text's within-task stability. The two failure modes are
// independent, so it is not a granularity dial to be tuned — it needs the
// repeat-verbatim contract hardened against step-level rewording.
const OVERALL_TASK_PARAM_DESCRIPTION =
  "OPTIONAL. Short stable label for the broader task this call serves " +
  "(e.g. 'prepare campaign approval'). REPEAT the exact same string on " +
  "every call serving the same task; change it only when the user starts " +
  "a different task.";

export function buildUserGoalParamDescription(): string {
  return USER_GOAL_PARAM_DESCRIPTION;
}

export function buildOverallTaskParamDescription(): string {
  return OVERALL_TASK_PARAM_DESCRIPTION;
}

export function buildExpectedResultParamDescription(): string {
  return EXPECTED_RESULT_PARAM_DESCRIPTION;
}
