/**
 * Annotation tool registration — SPEC §5.1.1. Registers a vendor-namespaced
 * tool (named by `annotationName.ts`: explicit, else the server's own name
 * slugged, else `{vendorId}_annotate`) that accepts the annotation
 * signature (user_goal / what_happened / tool_name / expected_result /
 * overall_task / suggested_improvement / context) and emits an `annotation`
 * event. Port of `baton` (Python)'s `integrations/official/annotation.py`
 * with `proactive_mode="off"`, the only mode this package has: `user_goal`
 * is required by the schema, and a call that is not a report is refused.
 *
 * Tool-name pattern (`^[a-zA-Z0-9_-]{1,64}$`) is the strictest known client
 * pattern (Claude Desktop) — dots, slashes, and other separators rejected.
 */

import { z } from "zod";
import { AnnotationEventSchema } from "../../events.js";
import { roundMetaCoordinates } from "../../metaCoordinates.js";
import type { Sink } from "../../sinks.js";
import { deriveAnnotationToolName } from "./annotationName.js";
import { emit } from "./emit.js";
import { type ResolvePrincipalHook, resolveCallPrincipal } from "./principalResolution.js";
import { buildAnnotationToolDescription } from "./llmText.js";
import { extraMeta, observeTransport, type Extra } from "./mcpTypes.js";
import type { SupportedMcpServer } from "./withBaton.js";
import { observeClient } from "./clientObserved.js";
import { resolveSessionId } from "./sessionResolution.js";
import { scrubOrNull } from "./safeScrub.js";
import type { SessionCounter } from "./sessionCounter.js";

/** The annotate tool's arguments. Spelled out because `SupportedMcpServer`
 * types `registerTool`'s config as `unknown` — the price of accepting both
 * SDK majors' nominally distinct servers — so nothing infers this from the
 * Zod shape below. The two must be kept in step; the round-trip tests call
 * the tool through a real client, so a drift shows up as a runtime failure
 * rather than passing silently. */
interface AnnotationArgs extends Record<string, unknown> {
  user_goal: string;
  expected_result?: string | undefined;
  what_happened?: string | undefined;
  tool_name?: string | null | undefined;
  overall_task?: string | undefined;
  suggested_improvement?: string | undefined;
  context?: Record<string, unknown> | undefined;
}

export interface RegisterAnnotationToolOptions {
  sink: Sink;
  counter: SessionCounter;
  tenantId: string;
  vendorId: string;
  vendorDisplayName: string;
  consentToken: string;
  fallbackSessionId: string;
  scrubber: (value: unknown) => unknown;
  annotationToolName?: string | undefined;
  /** The vendor's identity resolver — the SAME one the tool-call wrapper
   * holds. */
  resolvePrincipal?: ResolvePrincipalHook | undefined;
}

/** Advertised as required on the annotate tool by the `tools/list` seam in
 * withBaton.ts, and never enforced: the zod schema keeps it optional. */
export const TOOL_NAME_PARAM_NAME = "tool_name";

/** SPEC §11.4: an annotation is a report when its account is filled. */
export function isReport(whatHappened: string | null | undefined): whatHappened is string {
  return typeof whatHappened === "string" && whatHappened.trim() !== "";
}

/** Register the annotation tool on `server`. Returns the resolved tool name. */
export function registerAnnotationTool(
  server: SupportedMcpServer,
  options: RegisterAnnotationToolOptions,
): string {
  const name = deriveAnnotationToolName(options.vendorId, options.annotationToolName);
  const description = buildAnnotationToolDescription({
    vendorDisplayName: options.vendorDisplayName,
  });

  server.registerTool(
    name,
    {
      description,
      inputSchema: {
        user_goal: z.string(),
        expected_result: z.string().optional(),
        what_happened: z.string().optional(),
        // Nullable so a report whose agent sends an explicit null is taken,
        // not rejected by validation.
        tool_name: z.string().nullable().optional(),
        overall_task: z.string().optional(),
        suggested_improvement: z.string().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args: AnnotationArgs, extra: Extra) => {
      // Refused in the handler, not by requiring `what_happened` in the
      // schema: an agent that must fill it to get a call through invents a
      // problem, and that corrupts the reports.
      const whatHappened = args.what_happened;
      if (!isReport(whatHappened)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error:
                  `${name} is reactive-only on this server. Call it only AFTER ` +
                  "a tool call returns an unhelpful, empty, failed or " +
                  "contradictory result, or when no tool covers what the user " +
                  "asked for — and say what_happened. What the user is trying to " +
                  "do is already recorded on each tool call, so no pre-call " +
                  "annotation is needed.",
              }),
            },
          ],
        };
      }
      // Sent as given (SPEC §5.1.1): "" means the agent said no tool exists,
      // null means it said nothing, and the two must not merge.
      const reportedTool = args.tool_name ?? null;

      const meta = extraMeta(extra);
      // As in the tool-call wrapper: coordinates coarsened before the
      // vendor's scrubber.
      const scrubbedMeta = scrubOrNull(
        options.scrubber,
        meta ? roundMetaCoordinates(meta) : null,
        "_meta",
      );
      const sessionId = await resolveSessionId(options.fallbackSessionId, extra);

      // Same hook, same context factory as the tool wrapper — and the
      // `toolName` handed over is THIS tool's own name, so a hook keyed on it
      // answers per call rather than per install. Wiring one path and not the
      // other would put an annotation and the calls it describes under two
      // different actors, which is unjoinable downstream.
      const principal = await resolveCallPrincipal(
        options.resolvePrincipal,
        { extra, toolName: name, arguments: args },
      );

      await emit(options.sink, () =>
        AnnotationEventSchema.parse({
          tenant_id: options.tenantId,
          vendor_id: options.vendorId,
          session_id: sessionId,
          sequence_number: options.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          consent_token: options.consentToken,
          principal,
          transport_observed: observeTransport(extra),
          client_observed: observeClient(extra, { server, scrubber: options.scrubber }),
          runtime_meta: scrubbedMeta,
          payload: {
            // Agent-facing names -> wire keys, as with `overall_task`
            // below: `user_goal` is stored as `intent`, `expected_result` as
            // `expected_outcome`.
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            intent: options.scrubber(args.user_goal),
            expected_outcome: args.expected_result
              // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
              ? options.scrubber(args.expected_result)
              : null,
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            what_happened: options.scrubber(whatHappened),
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            tool_name: reportedTool ? options.scrubber(reportedTool) : reportedTool,
            // Agent-facing param `overall_task` -> wire key `workflow`, the same
            // split the injected params use (`overall_task` -> `call_workflow`):
            // renaming the param must not move the key the console groups on.
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            workflow: args.overall_task ? options.scrubber(args.overall_task) : null,
            suggested_improvement: args.suggested_improvement
              // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
              ? options.scrubber(args.suggested_improvement)
              : null,
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            context: args.context ? options.scrubber(args.context) : null,
          },
        }),
      );

      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
    },
  );

  return name;
}
