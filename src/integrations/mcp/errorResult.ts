/**
 * What result-derived data reaches the wire, and in what shape.
 *
 * Two halves of one question. Detecting MCP's returned error FLAG — the port
 * of `baton` (Python)'s `integrations/_error_result.py`, with one predicate
 * deliberately different, see `isErrorResult`. And the capture MODE (SPEC
 * §11.4), which decides whether any of it egresses at all. The second half
 * governs the SUCCESS path too, so a reader looking for "where is the result
 * on a good call decided" is in the right file despite the name — kept as
 * `errorResult.ts` because the filename pins parity with Python's module.
 *
 * SPEC §11.4.3. **A failed MCP tool call is a 200.** The protocol files it as a
 * successful JSON-RPC response whose `CallToolResult` body sets the error flag;
 * a JSON-RPC error means a protocol fault, not a tool failure. So classifying
 * on thrown exceptions alone — which is what §6.1 used to say, and what this
 * package did — files real failures as successes.
 *
 * ⚠ **One spelling, `isError`.** Python's helper probes `is_error` first
 * because that is a Python ATTRIBUTE name the `mcp` 2.x rewrite introduced;
 * MCP's own JSON-RPC schema is camelCase and every server dumps by alias
 * (wire probe, 2026-09-23: seven cells, `is_error` in none of them). The TS
 * SDKs have no snake_case era at all — measured 2026-09-24 on both majors,
 * the value this package sees is the vendor's own literal, camelCase.
 */

/** `error_type` for a returned error, as opposed to a thrown exception whose
 * constructor name is used. Same literal as Python's `TOOL_ERROR_TYPE` and as
 * `baton-extmcp`'s — sensor parity is the point. */
export const TOOL_ERROR_TYPE = "tool_error";

/** The registered values of `failure_kind` (SPEC §11.4.3), and the single
 * source of truth for them — same posture as `RESULT_CAPTURE_MODES` below,
 * for the same reason: a second hand-written list makes the guarantee "two
 * lists happen to agree".
 *
 * ⚠ **THREE of these four are spelled identically to the Console's error
 * code, and one renames.** Measured in
 * `baton-console/backend/src/baton_console/worker/errors.py`, whose
 * `_FAILURE_KIND_TO_CODE` is mostly an ALLOW-LIST: `unknown_tool`,
 * `tool_disabled` and `invalid_argument` map to codes of the same name
 * (`27566c2` added the first two as codes no TEXT lane can reach), and only
 * `output_schema_mismatch` renames, onto `schema_violation`, which already
 * described it.
 *
 * ⚠ A first version of this paragraph had that INVERTED — one match, three
 * renames — because it was copied from `iserror_sensor_probe.md`'s decision
 * table, written 2026-10-01, which recorded the buckets as they stood BEFORE
 * the Console side of this release landed the next day. Corrected rather than
 * overwritten, because the mechanism is the useful part: a design note's
 * "today" column goes stale the moment the thing it describes ships, and a
 * code comment that copies one inherits the staleness silently.
 *
 * The consequence of getting it wrong is not cosmetic. That table is an
 * allow-list, so an unregistered value is simply absent from it and falls
 * through to prose classification — which for `tool_disabled` means
 * `unclassified` with the full text in hand, the exact regression this member
 * exists to remove. `invalid_argument` is SINGULAR for that reason (Ujwal,
 * 2026-10-01): the plural was one letter off the Console's spelling, which is
 * the drift that already cost two defects this week.
 *
 * Open, not closed: `events.ts` types the wire member as a plain string, so a
 * later registered value cannot red a conforming producer (SPEC §11.2's
 * fail-open rule). This array is what THIS producer may emit. */
export const FAILURE_KINDS = [
  "unknown_tool",
  "tool_disabled",
  "invalid_argument",
  "output_schema_mismatch",
] as const;

/** What this producer may emit for `failure_kind`. Derived, so the type and
 * the registry cannot drift. */
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The one RESULT-SIDE kind: the handler returned and the producer's own
 * conversion of its output rejected it, so `error_body` and `result` are
 * result-derived and `"off"` withholds both. */
export const OUTPUT_SCHEMA_MISMATCH = "output_schema_mismatch" satisfies FailureKind;

/**
 * Which request-side kind a failure above the handler was, from the tool
 * entry the SDK itself looked up — NOT from the result.
 *
 * ⚠ **SPEC §11.4.3 forbids sorting these by inspecting the result object**,
 * and the reason is visible in both majors' `tools/call` handler: all three
 * arrive as the same shape. On 1.x all three are a returned `isError` whose
 * text is `createToolError`'s (`mcp.js:100-108`, inside the handler's own
 * `try`); on 2.x the first two THROW a `ProtocolError` and the third is a
 * returned `isError` (`mcp-DXXb3Vv3.mjs:1394-1397`). Reading the message
 * would be a regex in the producer, which is the thing `failure_kind` exists
 * to remove.
 *
 * So this reads the same two facts the SDK branched on, from the same
 * registry entry (`_registeredTools[name]`), which makes the label agree with
 * the SDK's own decision by construction rather than by matching its prose.
 * `SurfaceState` is deliberately NOT the source: it is a derived copy, it
 * excludes the annotate tool, and a tool registered before `withBaton` ran
 * reaches it only through the retroactive sweep.
 *
 * Absent entry → the tool does not exist. Present and disabled → the vendor
 * turned it off, which is a different remedy from a missing tool and the case
 * the Console cannot classify from text at all. Present and enabled → the
 * handler existed, was callable, and still never ran.
 *
 * ⚠ **That last step is NOT always argument validation, and a first version
 * of this function said it was.** On v2 it is: `tools/call` checks existence,
 * then `enabled`, then calls `validateToolInput`, with nothing in between
 * (`mcp-DXXb3Vv3.mjs:1394-1399`). On `@modelcontextprotocol/sdk` 1.x — the
 * pinned peer — TWO more pre-handler rejections sit in that gap
 * (`mcp.js:112-122`), and one of them is reachable for a tool this package
 * wraps: `execution.taskSupport` declared on a tool registered with an
 * ordinary function callback throws `InternalError` before any argument is
 * looked at. Labelling that `invalid_argument` tells the operator the agent
 * sent bad arguments when the remedy is the VENDOR's own registration — the
 * one failure mode this member exists to prevent, reintroduced by the
 * producer instead of by a regex.
 *
 * So a tool whose entry declares one of those two task modes withdraws the
 * claim: `undefined`, which SPEC §11.4.3 permits outright ("a producer that
 * cannot emit this member correctly MUST omit it"). The caller still emits
 * the event — the call failed and the SDK's own message says why — it just
 * does not name a kind it cannot determine. ⚠ The small untruth that buys:
 * §11.4.3 reads an absent member as "the vendor's handler spoke for itself",
 * which is not what happened here. Keeping the call visible with its real
 * message is the better of the two, and this is the one shape where that
 * reading is wrong.
 *
 * ⚠ **The predicate is `TASK_MODES`, not "is `taskSupport` set" — which was
 * the first version and would have cost `invalid_argument` on the ENTIRE
 * pinned peer.** Measured: 1.x's `registerTool` hands
 * `{taskSupport: "forbidden"}` to every ordinary tool it builds
 * (`mcp.js:694,704`), so the member is populated on all of them and the
 * presence test withdrew the claim universally. Caught by
 * `aboveTool.test.ts`'s 1.x leg, which is why that case asserts the kind per
 * major rather than once. The two values below are exactly the ones the SDK
 * itself branches on, which is this function's whole discipline.
 *
 * ⚠ The predicate stays on the REGISTRY ENTRY's own configuration, never the
 * message — and 1.x's OTHER branch (`"required"` without task augmentation)
 * needs no clause of its own, because it is reachable only when the handler
 * is a task OBJECT, which `dispatchSlot` already answers `undefined` for and
 * the seam already declines to report on.
 *
 * ⚠ **`TASK_MODES` is a PIN, not a principle, and that is the honest reading.**
 * The other two kinds rest on POSITIVE evidence — an absent entry, an
 * `enabled: false` flag — which is why they are stable across majors.
 * `invalid_argument` is the ELSE branch: an inference from the absence of any
 * other explanation. This `Set` patches that inference by enumerating the two
 * values of one major's `taskSupport` that sit in the gap TODAY, and the SDK
 * does not branch on `taskSupport` to decide THIS question — it branches on it
 * to decide something else, which the code is reading as a proxy. So the next
 * pre-handler rejection either major adds lands in `invalid_argument`
 * silently, with nothing going red, because the elimination still "succeeds".
 *
 * The real fix is positive evidence: a THIRD seam around the SDK's own input
 * validation, setting a `validatorRejected` fact on `CallSlot` the way
 * `innerFired` is set, after which this function is three positive tests and
 * no `else` and `TASK_MODES` disappears. Not taken here — it is another
 * per-major internals reach-in and the two majors spell validation
 * differently. Recorded so the `Set` is read as the version pin it is.
 */
const TASK_MODES: ReadonlySet<unknown> = new Set(["required", "optional"]);

/** The registry-entry members this decision reads, declared ONCE.
 *
 * `withBaton.ts`'s `ToolEntry` extends this with the two dispatch-target
 * members the seam needs. Declared here rather than hand-copied as a structural
 * literal because the next flag either SDK branches on has to be added in one
 * place, and `tsc` would not have noticed a second copy going stale. */
export interface ToolEntryFacts {
  enabled?: unknown;
  /** 1.x rejects a mis-declared task tool BEFORE argument validation, so this
   * member's VALUE is what withdraws the `invalid_argument` claim. */
  execution?: { taskSupport?: unknown } | null;
}

export function requestSideFailureKind(
  entry: ToolEntryFacts | null | undefined,
): FailureKind | undefined {
  // `== null`, not `=== undefined`: this entry comes out of a cast past the
  // SDK's `private`, so its shape is a declaration rather than a runtime
  // guarantee, and a null would otherwise raise a `TypeError` off a tool call
  // that was going to return the SDK's own error (SPEC §11.2 fail-open —
  // `settleCall`'s guard would catch it, but a sensor should not need one).
  if (entry == null) return "unknown_tool";
  if (entry.enabled === false) return "tool_disabled";
  return TASK_MODES.has(entry.execution?.taskSupport) ? undefined : "invalid_argument";
}

/** The `error_body` cap, in CODE POINTS, shared by both failure legs (SPEC
 * §11.4.3's two shapes) so a change to the limit cannot move one and leave
 * the other. Python caps the same field at the same number, and its `[:2000]`
 * counts code points — which is why the cut goes through `capCodePoints` and
 * not `String.prototype.slice`. */
export const ERROR_BODY_MAX_CODE_POINTS = 2000;

/**
 * True if `value` is a tool result carrying MCP's error flag.
 *
 * ⚠ **No `content`-must-be-a-list guard, and SPEC §11.4.3 now scopes that
 * rule by VANTAGE POINT rather than requiring it of every producer** — the
 * section said "MUST" unconditionally until 2026-09-24, and this package is
 * why it moved.
 * Python's adapter receives a result the library has already converted, so an
 * object carrying an `isError` attribute for its own reasons could reach it
 * and must be excluded. This package wraps the vendor's own executor, so what
 * arrives here is the vendor's LITERAL return, and both majors merge that
 * verbatim into the wire result.
 *
 * Measured 2026-09-24 on `@modelcontextprotocol/sdk` 1.x and
 * `@modelcontextprotocol/server` 2.x: a tool returning `{isError: true,
 * rows: 0}` — no `content` at all — reaches the CLIENT as
 * `{content: [], isError: true}`. There is no such thing here as an object
 * that merely spells the flag: spelling it at the top level of a tool's return
 * IS how a TS tool reports failure. A `content` guard would make this sensor
 * miss a failure its caller can see, which is the one thing it may not do.
 *
 * So the invariant is stronger and simpler than Python's, and
 * `errorResult.test.ts` asserts it directly: **for a failure the handler
 * itself reports, this predicate agrees with what the client received.**
 *
 * ⚠ **That scope is load-bearing, because a failure the SDK manufactures
 * ABOVE this wrap point is invisible here.** Measured 2026-09-24 on both
 * majors: a tool registered with an `outputSchema` whose handler returns
 * `content` and no `structuredContent` returns a success-shaped object, so
 * this predicate correctly answers false — and then the SDK's own output
 * validation, which runs after the executor, sends the client
 * `{isError: true, content: [{text: "Output validation error: …"}]}`. Baton
 * files `tool_call_end`. Nothing at the handler's vantage point can see it;
 * closing it needs a wrap above the request handler, or a sensor on the wire
 * — which is what `baton-proxy` is, and why the wire probe recorded that the
 * floor an SDK cannot see, the proxy can.
 *
 * ⚠ **And moving THIS sensor up to the request handler would cost more than
 * it closed**, which is why the gap is recorded rather than chased: both
 * majors convert a thrown handler error into a returned `isError` inside that
 * handler (`mcp.js:135`, `mcp-DXXb3Vv3.mjs:1404`), so above it the two failure
 * shapes are the same object and `error_type` collapses to `tool_error` for
 * both. Python's vector pins `"error_type": "ValueError"`. The throw/return
 * distinction only exists BELOW the request handler, which is where this sits.
 *
 * Guarded end to end — this runs on the vendor's tool-call path (SPEC §11.2:
 * never block the call), so it fails to False.
 */
export function isErrorResult(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null) return false;
    return Boolean((value as { isError?: unknown }).isError);
  } catch {
    return false;
  }
}

/**
 * The human-readable reason inside an error result.
 *
 * Joins the `content` envelope's text parts, which is where a vendor puts the
 * actual sentence ("You do not have sufficient access to delete this
 * Project"). This is what a human reads in the Console, so the fallback is
 * deliberately NOT `String(result)` — `[object Object]` would put noise where
 * the reason belongs. An empty string says "no reason given", which is honest
 * and which the Console already renders as such.
 *
 * ⚠ **No truncation here, deliberately.** The caller cuts AFTER scrubbing, to
 * `ERROR_BODY_MAX_CODE_POINTS`, on both failure legs alike.
 * Cutting inside this helper would put the truncation BEFORE the scrubber for
 * one of the two failure shapes and after it for the other — and a PII value
 * straddling the boundary would reach the scrubber as a fragment its pattern
 * cannot match, so the half that survives the cut ships unredacted. That is
 * the bug `/code-review` found in the Python change (`33581cb`); it is not
 * being ported.
 */
export function errorText(value: unknown): string {
  const parts: string[] = [];
  try {
    const content = (value as { content?: unknown })?.content;
    if (!Array.isArray(content)) return "";
    for (const part of content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text !== "string") continue;
      const trimmed = text.trim();
      if (trimmed) parts.push(trimmed);
    }
  } catch {
    return "";
  }
  return parts.join("\n");
}

/** The registered values of `resultCaptureMode` (SPEC §11.4), and the single
 * source of truth for them.
 *
 * A second hand-written list would make the guarantee "two lists happen to
 * agree". `config.ts` builds its validator set from THIS array rather than
 * restating the literals, so a mode cannot be accepted at the door without
 * someone having given it a payload shape below. */
export const RESULT_CAPTURE_MODES = ["full", "off"] as const;

/** What a vendor may set. Derived, so the type and the registry cannot drift. */
export type ResultCaptureMode = (typeof RESULT_CAPTURE_MODES)[number];

/** The one registered non-default value, on the wire and in the config alike.
 * A string and not a boolean because SPEC reserves a second value for the
 * content ladder's partial rung.
 *
 * `satisfies` and NOT a type annotation: an annotation widens this to
 * `ResultCaptureMode`, and then `case WITHHELD:` stops narrowing the switches
 * below — which silently costs the exhaustiveness that is the whole point of
 * deriving the registry. This keeps the literal type AND checks membership. */
export const WITHHELD = "off" satisfies ResultCaptureMode;

/** The `tool_call_end` payload members the capture mode decides.
 *
 * `result: null` under `"off"` is REDUNDANT here, and saying so is the point.
 * `ToolCallEndPayloadSchema.result` is `z.unknown().nullable().default(null)`,
 * so the key is present with a null value whether or not this branch names it —
 * the declare-rather-than-omit posture is the SCHEMA's, not this function's.
 * Dropping the literal yields a byte-identical wire shape and NOTHING detects
 * it. Kept because it states the intent at the site that decides the mode, not
 * because it is load-bearing.
 *
 * ⚠ **So do not look for a test that would catch its removal — there is none,
 * and two earlier versions of this paragraph named one.** The first said the
 * cross-SDK key-set check, which `withoutNulls` made blind; the second said
 * `errorResult.test.ts`'s `toContain("result")`, which lives in a throw-path
 * test that never sets `resultCaptureMode` and so never enters this branch. The
 * guarantee that matters is asserted where it is produced:
 * `resultCapture.test.ts` pins `result` null under `"off"` on this leg. ⚠ The
 * sibling claim on the THROW leg (`withBaton.ts`) does hold —
 * `ToolCallErrorPayloadSchema.result` is `.optional()` with no default, so
 * removing that literal is detectable. Two legs, two different answers, which is
 * why this says which is which. */
/** ⚠ PRECONDITION: call this ONLY from inside an `emit()` build thunk.
 * It applies the vendor's scrubber bare, which is correct there (a throw
 * drops the event) and wrong anywhere else (a throw reaches the agent as
 * `isError: true` on a call that worked — SPEC §11.2). This is still PROSE,
 * and prose is what let a site be missed once already: the `eslint-disable`
 * below pre-approves the bare call for any future caller, including one
 * outside a thunk. The structural fix is to take the scrubber as a thunk
 * ARGUMENT so no other caller can obtain it; recorded as F1b. */
export function endResultFields(
  mode: ResultCaptureMode,
  result: unknown,
  scrubber: (value: unknown) => unknown,
): { result: unknown; result_capture?: string } {
  // The scrubber is called HERE and not by the caller: SPEC §7 says it MUST
  // NOT be invoked on a withheld result, so a helper handed an already-scrubbed
  // value would be a guard standing after the thing it guards.
  switch (mode) {
    case WITHHELD:
      return { result: null, result_capture: WITHHELD };
    case "full":
      // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk (both callers are thunks): emit drops the event, which is correct for a result
      return { result: scrubber(result) };
  }
}

/** The RETURN failure shape's result-derived members (SPEC §11.4.3(2)).
 *
 * Both are unwrapped FROM the result — `error_body` from its `content` text
 * parts, `result` as the whole envelope — so `"off"` withholds both and
 * neither `errorText` nor the scrubber runs on it.
 *
 * ⚠ `error_body` becomes `""` rather than being dropped: it is REQUIRED on
 * `ToolCallErrorPayload`, and widening that array is a conformance change every
 * producer would have to follow. An empty `error_body` is genuinely ambiguous
 * with "the failure carried no message", and `result_capture` is what tells the
 * two apart — a second reason the marker is not optional.
 */
/** ⚠ PRECONDITION: call this ONLY from inside an `emit()` build thunk.
 * It applies the vendor's scrubber bare, which is correct there (a throw
 * drops the event) and wrong anywhere else (a throw reaches the agent as
 * `isError: true` on a call that worked — SPEC §11.2). This is still PROSE,
 * and prose is what let a site be missed once already: the `eslint-disable`
 * below pre-approves the bare call for any future caller, including one
 * outside a thunk. The structural fix is to take the scrubber as a thunk
 * ARGUMENT so no other caller can obtain it; recorded as F1b. */
export function returnedErrorFields(
  mode: ResultCaptureMode,
  result: unknown,
  errorBody: (text: string) => string,
  scrubber: (value: unknown) => unknown,
): { error_body: string; result: unknown; result_capture?: string } {
  return resultDerivedFields(mode, () => errorText(result), result, errorBody, scrubber);
}

/**
 * The same two members for ANY result-side failure, taking the text as a
 * THUNK rather than unwrapping it here.
 *
 * `returnedErrorFields` above is this with `errorText(result)` as the thunk.
 * The second caller is `failure_kind: "output_schema_mismatch"`, where the
 * handler returned and something above it rejected the output: the text there
 * may come off a THROWN value rather than off an envelope's `content`, so the
 * unwrapping cannot live in here.
 *
 * ⚠ **A thunk and not a string, which is the whole reason this is shaped this
 * way.** An eagerly-evaluated argument would unwrap a result the `"off"`
 * branch is about to discard — harmless to SPEC §7, which forbids only the
 * VENDOR's scrubber on a withheld result, but it would quietly retire the
 * property this module documents and tests: under `"off"` neither `errorText`
 * nor the scrubber touches the result at all.
 */
/** ⚠ PRECONDITION: call this ONLY from inside an `emit()` build thunk — same
 * as its two siblings, and for the same reason. */
export function resultDerivedFields(
  mode: ResultCaptureMode,
  text: () => string,
  result: unknown,
  errorBody: (value: string) => string,
  scrubber: (value: unknown) => unknown,
): { error_body: string; result: unknown; result_capture?: string } {
  switch (mode) {
    case WITHHELD:
      return { error_body: "", result: null, result_capture: WITHHELD };
    case "full":
      // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk (every caller is a thunk): emit drops the event, which is correct for a result
      return { error_body: errorBody(text()), result: scrubber(result) };
  }
}

/**
 * The REQUEST-SIDE failure's two body members, and it takes no capture mode
 * ON PURPOSE.
 *
 * The vendor's handler never ran, so there is no tool result anywhere in
 * this payload: `result` is null because none exists — the same reason
 * §11.4.3's RAISE shape carries null — and `error_body` is the SDK's own
 * rejection text, not anything a tool returned. Nothing here is
 * result-derived, so `"off"` has nothing to withhold and the event carries
 * **no `result_capture` marker**: SPEC §11.4's "present only when results
 * are withheld" applied, the same reading its library-path paragraph already
 * takes for an `error_body` the vendor supplied.
 *
 * ⚠ **`error_body` is KEPT under `"off"`, which is the rule's shape and not
 * an exception to it.** §11.4.3's table says so for all three request-side
 * kinds, and the provenance rule is why: this text describes the PRODUCER's
 * decision, the same standing as the strings `baton-proxy` authors for a
 * call it dropped. It is still scrubbed and capped — `invalid_argument`'s
 * message can echo the argument values the validator rejected, which is
 * exactly what a vendor scrubber is for.
 *
 * ⚠ **Taking a `mode` and ignoring it was the alternative, and it is worse**:
 * a reader would then have to find out WHY the switch has no branches, and a
 * later editor would add them. The absent parameter is the claim.
 */
/** ⚠ PRECONDITION: call this ONLY from inside an `emit()` build thunk — the
 * same precondition its two siblings above carry, for the same reason: it
 * applies the vendor's scrubber (through `errorBody`) bare. */
export function requestSideErrorFields(
  text: string,
  errorBody: (value: string) => string,
): { error_body: string; result: null } {
  return { error_body: errorBody(text), result: null };
}
