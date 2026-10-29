/**
 * Shared LLM-facing text: server instructions + annotation tool
 * description. Byte-for-byte port of `baton` (Python)'s
 * `integrations/_llm_text.py` template strings; see that module's
 * docstring for the rationale. Kept in sync by hand, as there is no
 * cross-language codegen for prose, and checked:
 * `test/integrations/mcp/llmTextVectors.json` is Python's own rendering,
 * compared string-for-string.
 *
 * **Python's DEFAULT text, `proactive_mode="off"`.** This arm has no
 * `proactiveMode`, so under `reportMode: "on"` it renders what Python renders
 * when that is unset: the instructions are one sentence pointing at the
 * annotation tool, and the tool's description holds the triggers, the
 * recovery rule and the fields, so each rule is written once.
 */

// Holds no report rule: each is written once, in the report tool's description.
const REPORT_POINTER_TEMPLATE = (vendorDisplayName: string, annotationToolName: string) =>
  `Use \`${annotationToolName}\` to report a ${vendorDisplayName} tool call ` +
  "that went wrong, or a request no tool covers; its description says when and how.";

// The Console splits user_goal on "; success is" (SPEC §11.5.1 rule 2).
const USER_GOAL_FORMAT = "'<n>: <what this call is for>; success is <what its result should show>'";

const ANNOTATION_TOOL_DESCRIPTION_TEMPLATE = (
  vendorDisplayName: string,
) => `Report a ${vendorDisplayName} tool call that went wrong, so \
${vendorDisplayName} can fix it. Call this right after a call errors, times \
out, or returns an empty, unhelpful or contradictory result. Also call it \
once per user request when no tool or field covers what they asked for, or \
you had to work around one. Do not call it before a tool call or for normal \
successful work.

A report does not replace the work: after it, work out why the call failed, \
fix the input and try again (do not repeat the same failing call), and still \
answer the user.

Fields:
  - user_goal: the same ${USER_GOAL_FORMAT} as on this server's other tools.
  - what_happened: REQUIRED. 1-2 plain sentences in your own words: what you \
asked for, what came back, and why it was unusable. Not a category.
  - tool_name: REQUIRED. The ${vendorDisplayName} tool that went wrong, or \
none if no tool exists for the request.
  - suggested_improvement: one concrete sentence on the product change that \
would have helped.
  - context: supplementary info not covered above. Common keys: plan, \
alternatives_considered, likely_cause, user_impact, error_class, \
downstream_blocked, confidence_in_intent. When no tool covers the \
request also missing_capability_field and requested_capability.`;

// Where Claude Code truncates InitializeResult.instructions. The cap below it
// leaves room for the fixed subagent sentence.
const CLAUDE_CODE_TRUNCATION_CAP = 2087;
const INSTRUCTIONS_LENGTH_CAP = 1500;

interface InstructionNames {
  vendorDisplayName: string;
  annotationToolName: string;
}

function renderServerInstructions(options: InstructionNames): string {
  return REPORT_POINTER_TEMPLATE(options.vendorDisplayName, options.annotationToolName);
}

/** Would these two names render under the cap? Asked by RENDERING, not by
 * arithmetic, so the answer cannot drift from the template: the interpolation
 * count and the cap both live here. Used by
 * `annotationName.ts` to keep a name derived from the server only where it
 * fits. */
export function fitsInstructionsCap(options: InstructionNames): boolean {
  return renderServerInstructions(options).length <= INSTRUCTIONS_LENGTH_CAP;
}

export function buildServerInstructions(options: InstructionNames): string {
  const rendered = renderServerInstructions(options);
  if (rendered.length > INSTRUCTIONS_LENGTH_CAP) {
    throw new Error(
      `Rendered server instructions are ${rendered.length} chars, which exceeds ` +
        `the ${INSTRUCTIONS_LENGTH_CAP}-char safety cap (Claude Code truncates at ` +
        `~${CLAUDE_CODE_TRUNCATION_CAP}). Shorten vendorDisplayName or annotationToolName.`,
    );
  }
  // The subagent sentence has no names in it, so it comes out of the headroom
  // under the truncation cap, not out of the budget the names share.
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
// Console cuts a turn where it changes (SPEC §11.5.1 rule 2).
//
// Do not reword: the text is the Python SDK's, byte for byte
// (`llmText.test.ts`, "parity with the Python SDK's rendered text"). Only the
// leading label tracks `intentParamMode`, so it agrees with the `required`
// list the `tools/list` seam advertises.
const USER_GOAL_PARAM_BODY =
  `Write it as ${USER_GOAL_FORMAT}. n is the number of the user's current message in this ` +
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
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Where our paragraph begins under `reportMode` "on" and "off". The pointer is
// matched whole: its opening, "Use `", is how a vendor's own paragraph may start.
const OURS_STARTS = [
  new RegExp(
    "^" + REPORT_POINTER_TEMPLATE("\u0000", "\u0000").split("\u0000").map(escapeRegExp).join(".+?"),
  ),
  new RegExp("^" + escapeRegExp(INTENT_INSTRUCTIONS)),
];

interface InstructionsHolder {
  _instructions?: string | undefined;
  [VENDOR_INSTRUCTIONS]?: string | undefined;
}

function endsInOurs(current: unknown, vendor: unknown): boolean {
  if (typeof current !== "string") return false;
  const prefix = typeof vendor === "string" && vendor.trim() ? `${vendor}\n\n` : "";
  if (!current.startsWith(prefix)) return false;
  const rest = current.slice(prefix.length);
  return OURS_STARTS.some((start) => start.test(rest));
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
