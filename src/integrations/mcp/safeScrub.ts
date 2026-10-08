import {
  EXPECTED_RESULT_PARAM_NAME,
  OVERALL_TASK_PARAM_NAME,
  USER_GOAL_PARAM_NAME,
} from "./llmText.js";

/** The fields a vendor scrubber is applied to OUTSIDE an `emit()` build thunk.
 *
 * A closed union rather than `string` for two reasons that both turned out to
 * matter. It makes a typo at a call site a compile error, where three of these
 * are also param-name constants two lines above the call. And it bounds the
 * warning set below to one line per field per process: a `string` would leave
 * that bound resting on every caller happening to pass a literal. */
export type ScrubbedField =
  | "agent-runtime name"
  | "client_observed"
  | "_meta"
  | typeof USER_GOAL_PARAM_NAME
  | typeof EXPECTED_RESULT_PARAM_NAME
  | typeof OVERALL_TASK_PARAM_NAME;

const warned = new Set<ScrubbedField>();

/** Fail-open wrapper around a VENDOR-supplied scrubber call.
 *
 * SPEC §11.2: Baton instrumentation MUST NOT break the vendor's tool call on
 * its own internal failure. `safeWrite` enforces that for `sink.write`, and
 * `emit` for payload CONSTRUCTION — but the scrubber also runs in plain
 * statements, outside any thunk, in both handlers. A throw there escapes both
 * guards and the call comes back to the agent as `isError: true`, which is the
 * one thing the fail-open property promises cannot happen. Reproduced on both
 * MCP majors before this existed. The default scrubber is ours, so the trigger
 * is a vendor-supplied one — exactly what §7 tells vendors handling sensitive
 * data they MUST supply.
 *
 * ⚠ **The rule is the POSITION, not a list of fields.** Every scrubber
 * application that is not inside an `emit()` build thunk needs this. An earlier
 * version of this comment listed the call sites instead of stating the rule, and
 * the byte-identical `_meta` line in `annotation.ts` was missed because of it —
 * found by review, not by the list. The lint rule in `eslint.config.js` now
 * refuses a bare scrubber call anywhere in `src/`, so a new site has to opt out
 * visibly rather than be remembered.
 *
 * `null` on failure because every caller already treats `null` as "this field is
 * not available": runtime detection loses the TIER and falls through to the
 * next, `_meta` becomes absent, an unscrubbed goal param becomes no captured
 * intent. So the field degrades and the call lives. `null` IN is returned
 * unchanged without calling the scrubber, which is what lets each caller drop
 * its own `x !== null ?` guard.
 *
 * ⚠ NOT for a scrubber call inside an `emit()` build thunk. There a throw is
 * already contained, and `null` would be WORSE than dropping the event: a null
 * `result` on a `tool_call_error` means "the handler raised" (SPEC §11.4.3), so
 * swallowing a scrubber failure into one would fabricate a failure shape. Drop
 * the event instead — which is what `emit` already does.
 */
export function scrubOrNull<T>(
  scrubber: (value: unknown) => unknown,
  value: T | null,
  field: ScrubbedField,
): T | null {
  if (value === null) return null;
  try {
    // eslint-disable-next-line no-restricted-syntax -- this IS the guard; the one call the rule exists to funnel every other through
    return scrubber(value) as T;
  } catch (err) {
    // Once per field per process. `safeWrite` logs per event because a sink
    // failure is one write per event; this fires up to five times per CALL, and
    // runtime detection fires unconditionally — so the unbounded form would put
    // a line on stderr for every tool call forever. Bounded the way
    // `principalResolution`'s pre-rename warning and `HttpSink.overflowWarned`
    // already are.
    if (!warned.has(field)) {
      warned.add(field);
      process.stderr.write(
        `baton: scrubber threw on ${field}; that field is dropped, tool call continues. ` +
          `Further failures on this field will be silent: ${String(err)}\n`,
      );
    }
    return null;
  }
}
