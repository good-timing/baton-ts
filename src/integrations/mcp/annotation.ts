/**
 * Annotation tool registration — SPEC §5.1.1. Registers a vendor-namespaced
 * tool (default `{vendorId}_annotate`) that accepts the annotation
 * signature (intent / expected_outcome / signal_type / workflow /
 * suggested_improvement / context) and emits an `annotation` event.
 * Faithful port of `baton` (Python)'s `integrations/fastmcp/annotation.py`
 * (`intent` required, everything else optional — same as the Python tool's
 * signature, not a TS-specific choice).
 *
 * Tool-name pattern (`^[a-zA-Z0-9_-]{1,64}$`) is the strictest known client
 * pattern (Claude Desktop) — dots, slashes, and other separators rejected.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AnnotationEventSchema } from "../../events.js";
import type { Sink } from "../../sinks.js";
import type { ResolveSessionIdHook } from "./config.js";
import { emit } from "./emit.js";
import { buildAnnotationToolDescription, SIGNAL_TYPES } from "./llmText.js";
import type { Extra } from "./mcpTypes.js";
import type { ProactiveTracker } from "./proactiveTracker.js";
import { detectAgentRuntime } from "./runtimeAdapter.js";
import { resolveSessionId } from "./sessionResolution.js";
import type { SessionCounter } from "./sessionCounter.js";

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function deriveAnnotationToolName(vendorId: string, override?: string): string {
  const name = override || `${vendorId}_annotate`;
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Annotation tool name ${JSON.stringify(name)} violates the cross-runtime ` +
        `pattern ${TOOL_NAME_PATTERN.source} (Claude Desktop and others reject ` +
        "names with dots or other separators).",
    );
  }
  return name;
}

export interface RegisterAnnotationToolOptions {
  sink: Sink;
  counter: SessionCounter;
  tenantId: string;
  vendorId: string;
  vendorDisplayName: string;
  consentToken: string;
  fallbackSessionId: string;
  defaultAgentRuntime: string;
  scrubber: (value: unknown) => unknown;
  resolveSessionId?: ResolveSessionIdHook | undefined;
  annotationToolName?: string | undefined;
  /** Shared with the tool-call wrapper so a session opens at most one
   * proactive annotation regardless of which path fires first. */
  tracker?: ProactiveTracker | undefined;
}

/** Register the annotation tool on `server`. Returns the resolved tool name. */
export function registerAnnotationTool(
  server: McpServer,
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
        intent: z.string(),
        expected_outcome: z.string().optional(),
        signal_type: z.enum(SIGNAL_TYPES).optional(),
        workflow: z.string().optional(),
        suggested_improvement: z.string().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args, extra: Extra) => {
      const meta = (extra._meta as Record<string, unknown> | undefined) ?? null;
      const runtime = detectAgentRuntime(meta) ?? options.defaultAgentRuntime;
      const scrubbedMeta = meta ? (options.scrubber(meta) as Record<string, unknown>) : null;
      const sessionId = await resolveSessionId(
        options.resolveSessionId,
        options.fallbackSessionId,
        extra,
        meta,
        name,
        args,
      );
      // A proactive annotation (no signal_type) claims the session's
      // proactive slot so the tool wrapper won't also synthesise one from
      // an injected `user_goal` param.
      if (args.signal_type === undefined) {
        options.tracker?.mark(sessionId);
      }

      await emit(options.sink, () =>
        AnnotationEventSchema.parse({
          tenant_id: options.tenantId,
          vendor_id: options.vendorId,
          session_id: sessionId,
          sequence_number: options.counter.next(sessionId),
          captured_at: new Date().toISOString(),
          consent_token: options.consentToken,
          agent_runtime: runtime,
          runtime_meta: scrubbedMeta,
          payload: {
            intent: options.scrubber(args.intent),
            expected_outcome: args.expected_outcome
              ? options.scrubber(args.expected_outcome)
              : null,
            // `signal_type` is a closed enum — nothing to scrub. `workflow`
            // is agent-authored free text ("processing invoice for
            // bob@example.com" is a realistic value), so it IS scrubbed.
            // Python's annotation.py does NOT scrub this field — a shared
            // gap found 2026-08-11, fixed here and flagged for the sibling
            // rather than mirrored. Not a wire divergence: scrubbing changes
            // content, not shape, and it's deterministic, so the
            // exact-string continuity rung 3b groups on survives.
            signal_type: args.signal_type ?? null,
            workflow: args.workflow ? options.scrubber(args.workflow) : null,
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
