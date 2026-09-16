/**
 * Annotation tool registration — SPEC §5.1.1. Registers a vendor-namespaced
 * tool (named by `annotationName.ts`: explicit, else the server's own name
 * slugged, else `{vendorId}_annotate`) that accepts the annotation
 * signature (user_goal / expected_result / signal_type / overall_task /
 * suggested_improvement / context) and emits an `annotation` event.
 * Faithful port of `baton` (Python)'s `integrations/fastmcp/annotation.py`
 * (`user_goal` required, everything else optional — same as the Python tool's
 * signature, not a TS-specific choice).
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
import { type ResolvePrincipalHook, resolveCallPrincipalId } from "./principalResolution.js";
import type { PrincipalIdMode } from "../../identity.js";
import { buildAnnotationToolDescription, SIGNAL_TYPES } from "./llmText.js";
import { extraEnvelope, extraMeta, observeTransport, type Extra } from "./mcpTypes.js";
import type { SupportedMcpServer } from "./withBaton.js";
import type { ProactiveTracker } from "./proactiveTracker.js";
import { detectAgentRuntime, UNKNOWN_AGENT_RUNTIME } from "./runtimeAdapter.js";
import { resolveSessionId } from "./sessionResolution.js";
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
  signal_type?: (typeof SIGNAL_TYPES)[number] | undefined;
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
  /** Shared with the tool-call wrapper so a session opens at most one
   * proactive annotation regardless of which path fires first. */
  tracker?: ProactiveTracker | undefined;
  /** The vendor's identity resolver and its hashing settings — the SAME
   * values the tool-call wrapper holds, resolved once at install. */
  resolvePrincipal?: ResolvePrincipalHook | undefined;
  principalIdMode: PrincipalIdMode;
  principalIdHmacKey: string | Uint8Array | undefined;
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
        signal_type: z.enum(SIGNAL_TYPES).optional(),
        overall_task: z.string().optional(),
        suggested_improvement: z.string().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args: AnnotationArgs, extra: Extra) => {
      const meta = extraMeta(extra);
      // Same ladder, same inputs as the tool-call wrapper. Wiring only one
      // of the two would give a single session two runtimes for one client
      // — tool events naming the client, annotations saying `unknown` —
      // which is the split N11 hit by wiring two of its four call sites.
      const runtime =
        detectAgentRuntime(meta, {
          envelope: extraEnvelope(extra),
          server,
          scrubber: options.scrubber,
        }) ?? UNKNOWN_AGENT_RUNTIME;
      // As in the tool-call wrapper: coordinates coarsened after the ladder
      // read the raw meta, before the vendor's scrubber (handoff D5).
      const scrubbedMeta = meta
        ? (options.scrubber(roundMetaCoordinates(meta)) as Record<string, unknown>)
        : null;
      const sessionId = await resolveSessionId(options.fallbackSessionId, extra);
      // A proactive annotation (no signal_type) claims the session's
      // proactive slot so the tool wrapper won't also synthesise one from
      // an injected `user_goal` param.
      if (args.signal_type === undefined) {
        options.tracker?.mark(sessionId);
      }

      // Same hook, same context factory as the tool wrapper — and the
      // `toolName` handed over is THIS tool's own name, so a hook keyed on it
      // answers per call rather than per install. Wiring one path and not the
      // other would put an annotation and the calls it describes under two
      // different actors, which is unjoinable downstream: the identical split
      // the runtime ladder above already carries a comment about.
      const principalId = await resolveCallPrincipalId(
        options.resolvePrincipal,
        { extra, toolName: name, arguments: args },
        {
          mode: options.principalIdMode,
          tenantId: options.tenantId,
          key: options.principalIdHmacKey,
        },
      );

      await emit(options.sink, () =>
        AnnotationEventSchema.parse({
          tenant_id: options.tenantId,
          vendor_id: options.vendorId,
          session_id: sessionId,
          sequence_number: options.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          consent_token: options.consentToken,
          agent_runtime: runtime,
          principal_id: principalId,
          transport_observed: observeTransport(extra),
          runtime_meta: scrubbedMeta,
          payload: {
            // Agent-facing names -> wire keys, as with `overall_task`
            // below: `user_goal` is stored as `intent`, `expected_result` as
            // `expected_outcome`.
            intent: options.scrubber(args.user_goal),
            expected_outcome: args.expected_result
              ? options.scrubber(args.expected_result)
              : null,
            // `signal_type` is a closed enum — nothing to scrub. The task label
            // is agent-authored free text ("processing invoice for
            // bob@example.com" is a realistic value), so it IS scrubbed.
            // Python's annotation.py does NOT scrub this field — a shared
            // gap found 2026-08-11, fixed here and flagged for the sibling
            // rather than mirrored. Not a wire divergence: scrubbing changes
            // content, not shape, and it's deterministic, so the
            // exact-string continuity rung 3b groups on survives.
            signal_type: args.signal_type ?? null,
            // Agent-facing param `overall_task` -> wire key `workflow`, the same
            // split the injected params use (`overall_task` -> `call_workflow`):
            // renaming the param must not move the key the console groups on.
            workflow: args.overall_task ? options.scrubber(args.overall_task) : null,
            suggested_improvement: args.suggested_improvement
              ? options.scrubber(args.suggested_improvement)
              : null,
            context: args.context ? options.scrubber(args.context) : null,
          },
        }),
      );

      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
    },
  );

  return name;
}
