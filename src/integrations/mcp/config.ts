/**
 * `BatonConfig` — vendor-side configuration for `withBaton`. A trimmed,
 * capture-only mirror of `baton` (Python)'s `integrations/_config.py::VendorConfig`
 * — see that module's docstrings for the fields this Phase 2 scaffold
 * deliberately omits (`vendorDisplayName`, `annotationToolName`,
 * `intentParamMode`): they only make sense once the `<vendor>_annotate`
 * tool + server `instructions` injection exist, which per CHARTER §5.1.2 is
 * a matched pair this package doesn't ship yet (tracked in CHANGELOG.md).
 */

import type { Sink } from "../../sinks.js";

// Vendor IDs double as tenant_id in vendor-mode tenancy (mirrors Python's
// `install_baton` setting `tenant_id=config.vendor_id`) — same pattern
// Python validates against, kept even though this scaffold has no
// annotation-tool name to derive from yet, so a vendor_id chosen now stays
// valid once Phase 2.5 adds it.
const VENDOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;

/** Normalized input to `BatonConfig.resolveSessionId`. Deliberately doesn't
 * carry the raw MCP SDK `extra` object — this shape is stable across
 * whatever the TS MCP ecosystem does with its request-handler signature. */
export interface SessionResolutionContext {
  meta: Record<string, unknown> | null;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type ResolveSessionIdHook = (
  context: SessionResolutionContext,
) => string | null | undefined | Promise<string | null | undefined>;

export interface BatonConfig {
  /** Short stable identifier for the vendor (e.g. `"acme"`). Also used as
   * `tenant_id` on every emitted event (vendor-mode tenancy). */
  vendorId: string;
  /** End-user consent token attached to every emitted event per SPEC §2.3 —
   * required, the Console MUST reject events missing it. */
  consentToken: string;
  /** Where events go. Defaults to `new StdoutSink()` — zero-config dev mode. */
  sink?: Sink;
  /** Default `agent_runtime` when `_meta` heuristics can't detect one. */
  defaultAgentRuntime?: string;
  /** PII scrubber per SPEC §7. Default is identity (no-op) — unlike Python's
   * `Scrubber()` default, this scaffold ships no scrub-rule implementation
   * yet (see README "What's deferred"); vendors handling sensitive data
   * MUST supply their own per CHARTER §3 rule 8. */
  scrubber?: (value: unknown) => unknown;
  /** Optional vendor-supplied session-id resolver, checked BEFORE
   * `extra.sessionId` — mirrors Python's `resolve_session_id` rung 0. */
  resolveSessionId?: ResolveSessionIdHook;
}

export function validateBatonConfig(config: BatonConfig): void {
  if (!VENDOR_ID_PATTERN.test(config.vendorId)) {
    throw new Error(
      `vendorId ${JSON.stringify(config.vendorId)} must match ${VENDOR_ID_PATTERN.source} ` +
        "— reserved for the annotation tool name prefix once Phase 2.5 adds it.",
    );
  }
  if (!config.consentToken) {
    throw new Error(
      "BatonConfig.consentToken is required per SPEC §2.3 — events without a " +
        "valid consent_token MUST be rejected by the consumer.",
    );
  }
}

export function identityScrub(value: unknown): unknown {
  return value;
}
