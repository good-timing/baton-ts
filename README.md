# @baton/sdk (TypeScript)

*The TypeScript counterpart to [`baton-sdk`](https://github.com/good-timing/baton) (Python) — structured signal capture for agent-mediated tool use over MCP.*

**Status: pre-publish.** `withBaton` instruments an `@modelcontextprotocol/sdk` `McpServer`: wraps every tool call, injects server `instructions`, registers the `<vendor>_annotate` tool (SPEC §5.1.1–§5.1.2), injects `user_goal`/`expected_result` intent params on every wrapped tool's schema, and captures a `surface_snapshot` of the vendor-true surface. What's still not here: MRTR (Python's `_is_mrtr_pause`/`_is_mrtr_continuation` — see [What's deferred](#whats-deferred): the official TS SDK hasn't released the corresponding MCP 2026-07-28 support yet, so there's nothing to port against), the low-level `Server` adapter, and a real PII scrub-rule implementation. Not yet published to npm.

## Why this exists

Most production MCP servers are TypeScript, not Python — see the [design note](https://github.com/good-timing/baton-internal) (private) for the motivating research. `baton-sdk` (Python) can't reach that half of the ecosystem. This package is the TS-native way in, wire-compatible with the Python SDK by construction (see [Wire compatibility](#wire-compatibility) below).

## What's here

- `Event` — a Zod-validated discriminated union over the five event types (`tool_call_start`, `tool_call_end`, `tool_call_error`, `annotation`, `surface_snapshot`), field-for-field with the Python SDK's Pydantic models.
- `StdoutSink` — JSONL to a writable stream (default `process.stderr` — MCP stdio transport reserves stdout for JSON-RPC framing).
- `HttpSink` — `POST {url}/v0/events` with bearer auth, bounded buffer, retry with backoff, circuit breaker. The contract any Baton-compatible collector consumes.
- `withBaton(server, config)` — wraps every tool call on an `@modelcontextprotocol/sdk` `McpServer` (peer dependency) and emits `tool_call_start` / `tool_call_end` / `tool_call_error`. Works regardless of whether tools are registered before or after `withBaton` runs, and survives a tool's `.update()`/`.remove()` after the fact too (see the module docstring in `src/integrations/mcp/withBaton.ts` for why that ordering/mutation independence is load-bearing, not incidental). Also injects server `instructions` and registers the `<vendor>_annotate` tool so the calling agent can supply structured intent/outcome/friction signal — same behavioral contract as Python's adapters, ported byte-for-byte (verified against the Python SDK's actual rendered output, not just eyeballed).
- Intent-param injection — `user_goal`/`expected_result` string params are spliced onto every wrapped tool's advertised schema (`intentParamMode: "optional"` by default, `"required"`, or `"off"`), stripped before the vendor handler runs, and surfaced as `tool_call_start.payload.call_intent`/`intent_source` plus a synthesised proactive `annotation` (at most one per session). This is the capture path that survives runtimes which drop `instructions` entirely (notably Claude Desktop). A tool that already declares one of these names itself is left alone for that field (`"native"` disposition) — its value is forwarded to the vendor untouched, not captured as intent. A tool registered with no `inputSchema` at all is left alone regardless of mode, so a zero-arg handler's calling convention never changes underneath it.
- `surface_snapshot` capture — the vendor-true (pre-injection) `server_info`/`capabilities`/`instructions`/tool list, hashed and emitted at most once per observed hash (lazily, on the first tool call — the high-level `McpServer` exposes no `tools/list` hook to capture on eagerly). Baton's own additions (the annotate tool, the injected params) are reported separately under `seam_augmentations`, never folded into the vendor-true snapshot.

`FileSink` / `MultiSink` are deliberately not here yet — see [What's deferred](#whats-deferred).

## What's deferred

**MRTR handling.** Investigated (2026-08-09), not implemented — blocked upstream, not a design gap. MCP 2026-07-28 is a real, released spec revision, and Python's official `mcp` SDK already ships it as `mcp==2.0.0` (released 2026-07-28, same day as the spec): real `InputRequiredResult`/`input_responses`/`request_state` types, with a genuine sealed/verified request-state mechanism (`mcp.server.request_state`). Baton's Python adapter (`_is_mrtr_pause`/`_is_mrtr_continuation`) ports that real, shipped shape — not a guess. The official **TypeScript** SDK, `@modelcontextprotocol/sdk`, has not released the corresponding version: latest on npm is `1.30.0`, published 2026-07-27 — one day *before* the spec revision — with no `2.0.0`, no beta, no `next` dist-tag as of 2026-08-09. There is nothing to duck-type against in TS today because the upstream SDK itself hasn't caught up, not because the mechanism is speculative. Separately, the *different* mechanism this TS SDK version already has for multi-round-trip calls — Tasks, object handlers with `createTask` — doesn't reach the code `withBaton` wraps at all: traced through `mcp.js`'s `CallToolRequestSchema` handler, a plain-function tool (the only kind `wrapIfNeeded` wraps) always resolves as one `await handler(args, extra)` with no server-side re-invocation; only object handlers with `createTask` go through the poll/resume path, and those are already explicitly skipped (`wrapIfNeeded`'s `typeof handler !== "function"` check, a separate known gap in its own right — see the module docstring in `withBaton.ts`). Revisit once `@modelcontextprotocol/sdk` ships its MCP 2026-07-28 release, or if Tasks support for function-handler tools becomes worth wrapping.

The low-level `Server` adapter (only the high-level `McpServer` is supported) and a real PII scrub-rule implementation (the `scrubber` hook exists; it's identity by default, same gap as core) are also not here. None of these block `npm publish` the way the instructions+annotate-tool pair did — see CHANGELOG.md for what's shipped.

## Usage

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withBaton, StdoutSink } from "@baton/sdk";

const server = new McpServer({ name: "your-vendor-mcp", version: "1.0.0" });
const handle = withBaton(server, {
  vendorId: "your-vendor",
  vendorDisplayName: "Your Vendor",
  consentToken: process.env.BATON_CONSENT_TOKEN!,
  sink: new StdoutSink(), // swap in HttpSink(...) to ship to a collector
});
// handle.annotationToolName === "your-vendor_annotate"

// register tools before or after withBaton — both are captured
server.registerTool("lookup", { inputSchema: { name: z.string() } }, async ({ name }) => {
  /* ... */
});
```

`@modelcontextprotocol/sdk` is a peer dependency — this package expects the vendor's own copy already in their tree, same shape as Python's `mcp`/`fastmcp` peer relationship.

## Wire compatibility

This is the load-bearing constraint (per [CHARTER](https://github.com/good-timing/baton/blob/main/docs/CHARTER.md) §3 rule 3): TS-emitted events must be JSON-identical in shape to Python-emitted ones, so the Console never has to branch on which SDK produced an event. `baton-spec` (submoduled at `baton-spec/`) is the neutral schema repo both SDKs are checked against — `test/conformance.test.ts` validates every event type against `baton-spec/events.schema.json` (ajv) and round-trips the real, Python-captured fixtures in `baton-spec/vectors/*.json` through this package's Zod schemas byte-for-byte.

## Development

```sh
git clone --recurse-submodules https://github.com/good-timing/baton-ts.git
cd baton-ts
npm install
npm run ci   # lint + typecheck + test + build — the canonical gate, matches CI
```

If you cloned without `--recurse-submodules`, run `git submodule update --init` before `npm test` — the conformance tests read fixtures from `baton-spec/`.

## Canonical docs

This repo has no `CHARTER.md`/`SPEC.md` of its own — those live in [`baton`](https://github.com/good-timing/baton) (`docs/CHARTER.md`, `docs/SPEC.md`) and apply here too. Read those before making architectural changes to this package.
