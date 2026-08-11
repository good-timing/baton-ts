/**
 * `BatonConfig` — vendor-side configuration for `withBaton`. A trimmed
 * mirror of `baton` (Python)'s `integrations/_config.py::VendorConfig`.
 */

import type { Sink } from "../../sinks.js";

// Vendor IDs double as tenant_id in vendor-mode tenancy (mirrors Python's
// `install_baton` setting `tenant_id=config.vendor_id`) and as the default
// annotation-tool-name prefix — same pattern Python validates against.
const VENDOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;

// Per-tool intent-param injection modes (mirrors baton-proxy's
// BATON_INTENT_PARAM and Python's VendorConfig.intent_param_mode).
const INTENT_PARAM_MODES = new Set(["optional", "required", "off"]);

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
  /** PII scrubber per SPEC §7, applied to tool params/results, `_meta`,
   * intent strings and error bodies before they reach the sink. Defaults to
   * the shipped default ruleset (`new Scrubber().scrub` — email, bearer,
   * sk-keys, AWS keys, JWTs, phones, Luhn-checked cards, plus sensitive
   * field names), matching `baton` (Python) and baton-proxy: on by default
   * so untouched integrations get scrubbing without the operator opting in.
   * Pass `identityScrub` to explicitly opt out, or supply your own. */
  scrubber?: (value: unknown) => unknown;
  /** Optional vendor-supplied session-id resolver, checked BEFORE
   * `extra.sessionId` — mirrors Python's `resolve_session_id` rung 0. */
  resolveSessionId?: ResolveSessionIdHook;
  /** Optional override for the annotation tool name. Default is
   * `{vendorId}_annotate`. */
  annotationToolName?: string;
  /** Per-tool intent-param injection (mirrors baton-extmcp's vendor-neutral
   * naming). `"optional"` (default) injects `user_goal`/`expected_result`
   * string params on every wrapped tool's advertised schema; `"required"`
   * also adds `user_goal` to the schema's required fields (`expected_result`
   * stays optional regardless); `"off"` disables injection. Both params are
   * stripped before the vendor handler runs, so the tool never sees them.
   * This is what captures intent on runtimes that drop `instructions`
   * (notably Claude Desktop) — where the annotation tool alone yields
   * nothing. A tool registered with no `inputSchema` at all is left alone
   * regardless of this setting (see `schemaCompat.injectGoalParams`). */
  intentParamMode?: "optional" | "required" | "off";
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
  if (config.intentParamMode !== undefined && !INTENT_PARAM_MODES.has(config.intentParamMode)) {
    throw new Error(
      `BatonConfig.intentParamMode ${JSON.stringify(config.intentParamMode)} must be one of ` +
        `${JSON.stringify([...INTENT_PARAM_MODES].sort())}.`,
    );
  }
}
