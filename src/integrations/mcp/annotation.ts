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
import { isRecord } from "../../_object.js";
import { AnnotationEventSchema } from "../../events.js";
import { roundMetaCoordinates } from "../../metaCoordinates.js";
import type { Sink } from "../../sinks.js";
import { deriveAnnotationToolName } from "./annotationName.js";
import { emit } from "./emit.js";
import { type ResolvePrincipalHook, callerEnvelope, resolveCaller } from "./principalResolution.js";
import { type CaptureSettings, overlayChanges } from "./captureSettings.js";
import type { Overlay } from "./overlays.js";
import { buildAnnotationToolDescription, buildRefusalText } from "./llmText.js";
import { standardInputJsonSchema, toolInputJsonSchema } from "./schemaCompat.js";
import { extraMeta, observeTransport, type Extra } from "./mcpTypes.js";
import type { SupportedMcpServer } from "./withBaton.js";
import { observeClient } from "./clientObserved.js";
import { resolveSessionId } from "./sessionResolution.js";
import { scrubOrNull } from "./safeScrub.js";
import type { SessionCounter } from "./sessionCounter.js";

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
  // Nullable so a report whose agent sends an explicit null is taken,
  // not rejected by validation.
  what_happened: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  suggested_improvement: z.string().nullable().optional(),
  // zod renders "any value" as `{}`, which some MCP clients refuse (reportToolSchema.test.ts).
  context: z.record(z.string(), z.unknown()).meta({ additionalProperties: true }).nullable().optional(),
};

const ANNOTATION_ARGS = z.object(ANNOTATION_INPUT_SHAPE);
type AnnotationArgs = z.infer<typeof ANNOTATION_ARGS>;

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

const INVALID_PARAMS = -32602;

type ToolInputValidator = {
  validateToolInput(tool: { inputSchema: unknown }, args: unknown, name: string): Promise<unknown>;
};

/** Registered without a schema when `callArguments` can supply the call's
 * arguments: the SDK would render the schema with the vendor's zod, which
 * crashes on Baton's when the copies differ (reportToolSchema.test.ts). */
export function registerAnnotationTool(
  server: SupportedMcpServer,
  options: RegisterAnnotationToolOptions,
  callArguments?: () => unknown,
): void {
  const tool = buildAnnotationTool(server, options);
  if (callArguments === undefined) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: ANNOTATION_INPUT_SHAPE }, tool.handler);
    return;
  }
  server.registerTool(tool.name, { description: tool.description }, async (extra: Extra) => {
    const args = callArguments();
    const { validateToolInput } = server as Partial<ToolInputValidator>;
    let parsed: unknown;
    try {
      // The SDK's own check, so a refusal reads as it does for any tool with this schema.
      parsed = await validateToolInput?.call(server, { inputSchema: ANNOTATION_ARGS }, args, tool.name);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === INVALID_PARAMS) throw err;
    }
    // A private SDK method: if it is gone or changed, Baton checks the arguments itself.
    return isRecord(parsed) ? tool.handler(parsed as AnnotationArgs, extra) : callAnnotationTool(tool, args, extra);
  });
}

/** The report tool's input schema as Baton lists it on a server of that
 * major: v2 renders draft 2020-12 from the schema itself, 1.x through its own
 * converter. */
export function annotationInputJsonSchema(major: 1 | 2): Record<string, unknown> {
  // A zod without the Standard JSON Schema interface falls back to the 1.x
  // converter, so a vendor's boot never fails on the report tool's schema.
  return (annotationJsonSchemas[major] ??=
    (major === 2 ? standardInputJsonSchema(ANNOTATION_ARGS) : undefined) ?? toolInputJsonSchema(ANNOTATION_INPUT_SHAPE));
}

const annotationJsonSchemas: Partial<Record<1 | 2, Record<string, unknown>>> = {};

/** `tools/call` for the annotation tool where the SDK does not check its
 * arguments, so the check `McpServer` makes is made here. */
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
  const refused = (overlay?: Overlay) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: buildRefusalText({ annotationToolName: name, overlay }) }),
      },
    ],
  });

  return {
    name,
    description,
    handler: async (args: AnnotationArgs, extra: Extra) => {
      // Refused in the handler, not by requiring `what_happened` in the
      // schema: an agent that must fill it to get a call through invents a
      // problem, and that corrupts the reports.
      const whatHappened = args.what_happened;
      if (!isReport(whatHappened) && !overlayChanges(options.captureSettings, "report_tool.refusal")) return refused();
      // Sent as given (SPEC §5.1.1): "" means the agent said no tool exists,
      // null means it said nothing, and the two must not merge.
      const reportedTool = args.tool_name ?? null;

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
      if (!isReport(whatHappened)) return refused(caller.settings?.overlay);

      const meta = extraMeta(extra);
      // As in the tool-call wrapper: coordinates coarsened before the
      // vendor's scrubber.
      const scrubbedMeta = scrubOrNull(
        options.scrubber,
        meta ? roundMetaCoordinates(meta) : null,
        "_meta",
      );
      const session = await resolveSessionId(options.fallbackSessionId, extra);

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
            intent: args.user_goal ? options.scrubber(args.user_goal) : null,
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
