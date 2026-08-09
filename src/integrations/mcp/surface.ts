/**
 * Shared `surface_snapshot` helpers — mirrors `baton` (Python)'s
 * `integrations/_surface.py` (see that module's docstring for full
 * rationale). The vendor-true surface (`server_info`/`capabilities`/
 * `instructions` + the tool list) is hashed (canonical JSON, sorted keys)
 * and emitted once per observed hash.
 *
 * The hash MUST reflect only the vendor's real surface, never anything
 * Baton adds — `buildServerMeta` MUST run before `withBaton` mutates server
 * instructions, and callers must capture each tool's `inputSchema` (via
 * `schemaCompat.toolInputJsonSchema`) before `injectGoalParams` mutates it,
 * or toggling `intentParamMode` would invalidate every hash a recipe was
 * pinned against.
 *
 * NOT guaranteed to match a Python- or proxy-observed hash of the "same"
 * server: each producer serializes `tools` from a different shape.
 */

import { createHash } from "node:crypto";

export function surfaceHash(surface: unknown): string {
  const canonical = canonicalJson(surface);
  const digest = createHash("sha256").update(canonical, "utf-8").digest("hex");
  return `sha256:${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

export interface ServerMeta {
  server_info: { name: string; version: string } | null;
  capabilities: Record<string, unknown> | null;
  instructions: string | null;
}

/** Vendor-true `server_info`/`capabilities`/`instructions`, read from the
 * low-level `Server` (`McpServer.server`) BEFORE `withBaton` sets its own
 * instructions suffix. `_serverInfo`/`_instructions` are private fields
 * with no public getter — same reach-in class as `withBaton.ts`'s
 * `_registeredTools`/`_instructions`; `getCapabilities()` is public. */
export function buildServerMeta(lowlevelServer: unknown): ServerMeta {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  const server = lowlevelServer as any;
  const info = server._serverInfo as { name?: string; version?: string } | undefined;
  const capabilities =
    typeof server.getCapabilities === "function"
      ? (server.getCapabilities() as Record<string, unknown>)
      : null;
  const instructions = (server._instructions as string | undefined) ?? null;
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  return {
    server_info: info ? { name: info.name ?? "", version: info.version ?? "" } : null,
    capabilities: capabilities ?? null,
    instructions,
  };
}

export function assembleSurface(
  serverMeta: ServerMeta,
  tools: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    server_info: serverMeta.server_info,
    capabilities: serverMeta.capabilities,
    instructions: serverMeta.instructions,
    tools,
  };
}

/** The as-served delta Baton added on top of the vendor-true surface —
 * mirrors proxy's/Python's `seam_augmentations` so a consumer can render
 * both layers. Always records `instructions_suffix: true`: the SDK's
 * `buildServerInstructions` unconditionally documents the annotation tool
 * whenever `withBaton` runs. */
export function buildSeamAugmentations(options: {
  injectedToolNames: string[];
  intentParamNames: string[];
  intentParamMode: "optional" | "required" | "off";
}): Record<string, unknown> {
  return {
    injected_tools: [...options.injectedToolNames].sort(),
    intent_param:
      options.intentParamMode !== "off"
        ? { names: [...options.intentParamNames].sort(), mode: options.intentParamMode }
        : null,
    instructions_suffix: true,
  };
}
