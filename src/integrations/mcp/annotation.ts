/**
 * Annotation tool registration — SPEC §5.1.1. Registers a vendor-namespaced
 * tool (named by `annotationName.ts`: explicit, else the server's own name
 * slugged, else `{vendorId}_annotate`) that accepts the annotation
 * signature (user_goal / what_happened / tool_name / suggested_improvement /
 * context) and emits an `annotation`
 * event. Port of `baton` (Python)'s `integrations/official/annotation.py`
 * `user_goal` is required by the schema, and a call that is not a report is
 * refused.
 *
 * Tool-name pattern (`^[a-zA-Z0-9_-]{1,64}$`) is the strictest known client
 * pattern (Claude Desktop) — dots, slashes, and other separators rejected.
 */

import { z } from "zod";
import { isBlank } from "../../_text.js";
import { AnnotationEventSchema } from "../../events.js";
import { roundMetaCoordinates } from "../../metaCoordinates.js";
import type { Sink } from "../../sinks.js";
import { deriveAnnotationToolName } from "./annotationName.js";
import { emit } from "./emit.js";
import { type ResolvePrincipalHook, callerEnvelope, resolveCaller } from "./principalResolution.js";
import type { CaptureSettings } from "./captureSettings.js";
import { buildAnnotationToolDescription, buildRefusalText } from "./llmText.js";
import { standardInputJsonSchema, toolInputJsonSchema } from "./schemaCompat.js";
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
  what_happened?: string | undefined;
  tool_name?: string | null | undefined;
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
  captureSettings?: CaptureSettings | undefined;
}

/** Advertised as required on the annotate tool (by the `tools/list` seam in
 * withBaton.ts, and in `reportTool`'s schema) and never enforced: the zod
 * schema keeps it optional. */
export const TOOL_NAME_PARAM_NAME = "tool_name";

export const ANNOTATION_INPUT_SHAPE = {
  user_goal: z.string(),
  what_happened: z.string().optional(),
  // Nullable so a report whose agent sends an explicit null is taken,
  // not rejected by validation.
  tool_name: z.string().nullable().optional(),
  suggested_improvement: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
};

/** SPEC §11.4: an annotation is a report when its account is filled. */
export function isReport(whatHappened: unknown): whatHappened is string {
  return typeof whatHappened === "string" && !isBlank(whatHappened);
}

export interface AnnotationTool {
  name: string;
  description: string;
  /** Runs on arguments the input schema has already accepted. */
  handler: (args: AnnotationArgs, extra: Extra) => Promise<CallToolResultLike>;
}

interface CallToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Register the annotation tool on `server`. Returns the resolved tool name. */
export function registerAnnotationTool(
  server: SupportedMcpServer,
  options: RegisterAnnotationToolOptions,
): string {
  const tool = buildAnnotationTool(server, options);
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: ANNOTATION_INPUT_SHAPE },
    tool.handler,
  );
  return tool.name;
}

const ANNOTATION_ARGS = z.object(ANNOTATION_INPUT_SHAPE);

/** The input schema as that major's `McpServer` lists it: v2 renders draft
 * 2020-12 from the schema itself, 1.x through its own converter. */
export function annotationInputJsonSchema(major: 1 | 2): Record<string, unknown> {
  // A zod without the Standard JSON Schema interface falls back to the 1.x
  // converter, so a vendor's boot never fails on the report tool's schema.
  return (annotationJsonSchemas[major] ??=
    (major === 2 ? standardInputJsonSchema(ANNOTATION_ARGS) : undefined) ?? toolInputJsonSchema(ANNOTATION_INPUT_SHAPE));
}

const annotationJsonSchemas: Partial<Record<1 | 2, Record<string, unknown>>> = {};

/** `tools/call` for the annotation tool on a server with no tool registry to
 * validate its arguments, so the check `McpServer` makes is made here. */
export function callAnnotationTool(
  tool: AnnotationTool,
  args: unknown,
  extra: Extra,
): Promise<CallToolResultLike> {
  const parsed = ANNOTATION_ARGS.safeParse(args ?? {});
  if (parsed.success) return tool.handler(parsed.data, extra);
  return Promise.resolve({
    content: [{ type: "text", text: `Invalid arguments for tool ${tool.name}: ${parsed.error.message}` }],
    isError: true,
  });
}

/** The annotation tool for `server`, which is read only for the client the
 * `initialize` handshake declared. */
export function buildAnnotationTool(
  server: unknown,
  options: RegisterAnnotationToolOptions,
): AnnotationTool {
  const name = deriveAnnotationToolName(options.vendorId, options.annotationToolName);
  const description = buildAnnotationToolDescription({
    vendorDisplayName: options.vendorDisplayName,
  });
  const refusal = buildRefusalText({ annotationToolName: name });

  return {
    name,
    description,
    handler: async (args: AnnotationArgs, extra: Extra) => {
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
                error: refusal,
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
      const session = await resolveSessionId(options.fallbackSessionId, extra);

      // Same hook, same context factory as the tool wrapper — and the
      // `toolName` handed over is THIS tool's own name, so a hook keyed on it
      // answers per call rather than per install. Wiring one path and not the
      // other would put an annotation and the calls it describes under two
      // different actors, which is unjoinable downstream.
      const client = observeClient(extra, { server, scrubber: options.scrubber });
      const caller = await resolveCaller(
        options.resolvePrincipal,
        { extra, toolName: name, arguments: args },
        options.captureSettings,
        client,
      );

      await emit(options.sink, () =>
        AnnotationEventSchema.parse({
          tenant_id: options.tenantId,
          vendor_id: options.vendorId,
          session_id: session.sessionId,
          sequence_number: options.counter.nextFor(session),
          captured_at: new Date().toISOString(),
          consent_token: options.consentToken,
          ...callerEnvelope(caller),
          transport_observed: observeTransport(extra),
          session_id_origin: session.origin,
          client_observed: client,
          runtime_meta: scrubbedMeta,
          payload: {
            // The agent-facing `user_goal` is stored as the wire key `intent`.
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            intent: options.scrubber(args.user_goal),
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            what_happened: options.scrubber(whatHappened),
            // eslint-disable-next-line no-restricted-syntax -- inside the emit() build thunk: a throw is already contained, and null here would fabricate a shape
            tool_name: reportedTool ? options.scrubber(reportedTool) : reportedTool,
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
  };
}
