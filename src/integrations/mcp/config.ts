/**
 * `BatonConfig` — vendor-side configuration for `withBaton`. A trimmed
 * mirror of `baton` (Python)'s `integrations/_config.py::VendorConfig` —
 * still missing `intentParamMode` (intent-param injection is out of scope;
 * see README "What's deferred").
 */

import type { Sink } from "../../sinks.js";

// Vendor IDs double as tenant_id in vendor-mode tenancy (mirrors Python's
// `install_baton` setting `tenant_id=config.vendor_id`) and as the default
// annotation-tool-name prefix — same pattern Python validates against.
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
   * `tenant_id` on every emitted event (vendor-mode tenancy) and as the
   * default annotation tool name prefix (`{vendorId}_annotate`). */
  vendorId: string;
  /** Human-readable vendor name used in server instructions and the
   * annotation tool description — whitelabel obligation (SPEC §5.4): no
   * Baton-branded strings reach the calling agent. */
  vendorDisplayName: string;
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
  /** Optional override for the annotation tool name. Default is
   * `{vendorId}_annotate`. */
  annotationToolName?: string;
}

export function validateBatonConfig(config: BatonConfig): void {
  if (!VENDOR_ID_PATTERN.test(config.vendorId)) {
    throw new Error(
      `vendorId ${JSON.stringify(config.vendorId)} must match ${VENDOR_ID_PATTERN.source} ` +
        "— used as the default annotation tool name prefix.",
    );
  }
  if (!config.vendorDisplayName) {
    throw new Error(
      "BatonConfig.vendorDisplayName is required — used in server instructions " +
        "and the annotation tool description (whitelabel obligation, SPEC §5.4).",
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
