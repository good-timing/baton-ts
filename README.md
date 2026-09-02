# @goodtiming/baton-sdk (TypeScript)

*The TypeScript counterpart to [`baton-sdk`](https://github.com/good-timing/baton) (Python) — structured signal capture for agent-mediated tool use over MCP.*

**Status: published — [`@goodtiming/baton-sdk@0.1.0`](https://www.npmjs.com/package/@goodtiming/baton-sdk) on npm.** `withBaton` instruments a high-level `McpServer` — **either** official SDK major, 1.x (`@modelcontextprotocol/sdk`) or v2 (`@modelcontextprotocol/server`): wraps every tool call, injects server `instructions`, registers the `<vendor>_annotate` tool (SPEC §5.1.1–§5.1.2), injects `user_goal`/`expected_result`/`overall_task` intent params on every wrapped tool's schema, captures a `surface_snapshot` of the vendor-true surface, and PII-scrubs every payload with the same default ruleset the Python SDK ships. What's still not here: intent-param injection for **non-zod** schemas on v2, MRTR (Python's `_is_mrtr_pause`/`_is_mrtr_continuation`), and the low-level `Server` adapter — see [What's deferred](#whats-deferred).

## Why this exists

Most production MCP servers are TypeScript, not Python — see the [design note](https://github.com/good-timing/baton-internal) (private) for the motivating research. `baton-sdk` (Python) can't reach that half of the ecosystem. This package is the TS-native way in, wire-compatible with the Python SDK by construction (see [Wire compatibility](#wire-compatibility) below).

## What's here

- `Event` — a Zod-validated discriminated union over the five event types (`tool_call_start`, `tool_call_end`, `tool_call_error`, `annotation`, `surface_snapshot`), field-for-field with the Python SDK's Pydantic models.
- `StdoutSink` — JSONL to a writable stream (default `process.stderr` — MCP stdio transport reserves stdout for JSON-RPC framing).
- `HttpSink` — `POST {url}/v0/events` with bearer auth, bounded buffer, retry with backoff, circuit breaker. The contract any Baton-compatible collector consumes.
- `withBaton(server, config)` — wraps every tool call on a high-level `McpServer` from either SDK major (both optional peer dependencies) and emits `tool_call_start` / `tool_call_end` / `tool_call_error`. Works regardless of whether tools are registered before or after `withBaton` runs, and survives a tool's `.update()`/`.remove()` after the fact too (see the module docstring in `src/integrations/mcp/withBaton.ts` for why that ordering/mutation independence is load-bearing, not incidental). Also injects server `instructions` and registers the `<vendor>_annotate` tool so the calling agent can supply structured intent/outcome/friction signal — same behavioral contract as Python's adapters, ported byte-for-byte (verified against the Python SDK's actual rendered output, not just eyeballed).
- Intent-param injection — `user_goal`/`expected_result`/`overall_task` string params are spliced onto every wrapped tool's advertised schema (`intentParamMode: "optional"` by default, `"required"` — which promotes only `user_goal` — or `"off"`), stripped before the vendor handler runs, and surfaced as `tool_call_start.payload.call_intent`/`call_expected`/`call_workflow`/`intent_source` plus a synthesised proactive `annotation` (at most one per session). `call_intent`/`call_expected` are call-scoped diagnostics that reword freely; `call_workflow` is the task-label grouping key the Console segments sessions on, which is why its injected param description carries an explicit repeat-the-exact-string contract. This is the capture path that survives runtimes which drop `instructions` entirely (notably Claude Desktop). A tool that already declares one of these names itself is left alone for that field (`"native"` disposition) — its value is forwarded to the vendor untouched, not captured as intent. A tool registered with no `inputSchema` at all is left alone regardless of mode, so a zero-arg handler's calling convention never changes underneath it.
- `surface_snapshot` capture — the vendor-true (pre-injection) `server_info`/`capabilities`/`instructions`/tool list, hashed and emitted at most once per observed hash (lazily, on the first tool call — the high-level `McpServer` exposes no `tools/list` hook to capture on eagerly). Baton's own additions (the annotate tool, the injected params) are reported separately under `seam_augmentations`, never folded into the vendor-true snapshot.
- PII scrubbing — every payload (tool params/results, `_meta`, intent strings, error bodies) runs through `Scrubber` before it reaches any sink, **on by default**. The ruleset is a rule-for-rule port of Python's `baton.scrub` (email, `Bearer` values, `sk-*` keys, `AKIA*` keys, JWTs, phone numbers, Luhn-checked card numbers, plus force-redaction on sensitive field names) — parity verified by mirroring Python's test matrix case-for-case *and* by diffing both implementations' output over a shared corpus. Pass `identityScrub` to opt out explicitly, or supply your own `(value: unknown) => unknown`.

`FileSink` / `MultiSink` are deliberately not here yet — see [What's deferred](#whats-deferred).

## What's deferred

**Intent-param injection for non-zod schemas (v2 only).** v2's primary `registerTool` overload accepts any `StandardSchemaWithJSON` — ArkType, Valibot, or a hand-rolled object — and its `ZodRawShape` overload is marked `@deprecated`. A non-zod schema has no `.shape` to splice `user_goal`/`expected_result`/`overall_task` into, so such a tool is still wrapped and still emits `tool_call_*`; it just advertises no intent params. Making injection work there means decorating the schema's `~standard.jsonSchema.input()`, which advertises correctly but leaves validation with the vendor's own schema, so the injected params could not be required. Stated here rather than discovered later.

**The `createMcpHandler` deployment shape (v2).** v2's flagship HTTP model builds a fresh `McpServer` per request, which would make `withBaton` run per request and turn the fallback session id, the sequence counter and the surface-snapshot dedup into request-lifetime state. Unscoped.

**MRTR handling.** Investigated 2026-08-09 and **that finding is now corrected**: it concluded "blocked upstream — nothing to duck-type against," on the strength of `npm view @modelcontextprotocol/sdk` showing `1.30.0` with no `2.0.0`, beta or `next` tag. That query was scoped to a package name the 2.0 line never used, so it could not have seen the release; the detail recorded as reassuring — 1.30.0 landing one day *before* the spec — was in fact the last release before the split. MCP 2026-07-28's MRTR mechanism (`InputRequiredResult`/`input_responses`/`request_state`) ships in Python's `mcp==2.0.0` **and** in `@modelcontextprotocol/server@2.0.0`, whose type declarations carry `InputRequired` and `requestState` throughout. So there is something to port against now, and with v2 support landed MRTR is no longer behind anything — it is simply the next piece of work, and v2's **exported** type guards (`isInputRequiredResult`, `isTaskAugmentedRequestParams`) make it easier to port against than Python's duck-typed adapter. Separately and still true: the *different* multi-round-trip mechanism 1.x already has — Tasks, object handlers with `createTask` — doesn't reach the code `withBaton` wraps at all. Traced through `mcp.js`'s `CallToolRequestSchema` handler, a plain-function tool (the only kind `wrapIfNeeded` wraps) always resolves as one `await handler(args, extra)` with no server-side re-invocation; only object handlers with `createTask` take the poll/resume path, and those are already skipped by `wrapIfNeeded`'s `typeof handler !== "function"` check on the 1.x path — a separate known gap, see the module docstring in `withBaton.ts`.

The low-level `Server` adapter (only the high-level `McpServer` is supported) is also not here. Neither blocks `npm publish` the way the instructions+annotate-tool pair did — see CHANGELOG.md for what's shipped.

## Usage

```bash
npm install @goodtiming/baton-sdk
```

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withBaton, StdoutSink } from "@goodtiming/baton-sdk";

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

Both `@modelcontextprotocol/sdk` (1.x) and `@modelcontextprotocol/server` (v2) are declared as **optional** peer dependencies: install whichever your server is built on, and nothing here resolves the other. This package imports neither — not at runtime, and not as a type, so a v2-only tree typechecks as well as it runs. `withBaton` takes the exported structural `SupportedMcpServer` type that both majors' `McpServer` classes satisfy, which is also how you annotate the parameter in your own code.

Same shape as Python's `mcp`/`fastmcp` peer relationship: the vendor's own copy, already in their tree.

## Wire compatibility

This is the load-bearing constraint (per [CHARTER](https://github.com/good-timing/baton/blob/main/docs/CHARTER.md) §3 rule 3): TS-emitted events must be JSON-identical in shape to Python-emitted ones, so the Console never has to branch on which SDK produced an event. `baton-spec` (submoduled at `baton-spec/`) is the neutral schema repo both SDKs are checked against, and it's enforced at two levels:

- **Schema** (`test/conformance.test.ts`) — validates every event type against `baton-spec/events.schema.json` (ajv) and round-trips the real, Python-captured fixtures in `baton-spec/vectors/*.json` through this package's Zod schemas byte-for-byte.
- **Emitter** (`test/emitterConformance.test.ts`) — drives a real tool call through `withBaton` and diffs the *emitted* events against those same vectors, field-for-field. The scenario mirrors `baton-spec/scripts/generate.py`, the script that produced the vectors by driving the identical scenario through the Python SDK. Envelope and payload key sets must match exactly; values must match except for a short, individually-justified exemption list (`event_id`, `session_id`, `captured_at`, `sdk_version`, timings, and the genuinely language-specific bits like `error_type` and the FastMCP-vs-Zod-derived tool schemas). Event ordering and `sequence_number` assignment are asserted against the Python run too.

The schema check alone can't catch an emitter that populates a field Python leaves null, starts `sequence_number` at 0, or orders events differently — hence the second level. No Python toolchain is needed in CI: the vectors are themselves real Python-emitted envelopes, so they *are* the cross-SDK reference. When the Python SDK's wire output changes, `generate.py` is re-run and the updated vectors arrive through a submodule bump — which is exactly what should fail these tests.

That is not hypothetical: the submodule was pinned at the initial schema commit while Python had moved on to `call_expected`/`call_workflow`, so both conformance levels were passing against a superseded contract. Bumping to `d5e25ea` failed three tests and surfaced the real gap — `overall_task` injection was missing entirely, meaning a TS-sourced session carried no `call_workflow` for the Console to group tasks by. **Keep the submodule current; a stale pin makes these tests pass loudly and prove nothing.**

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
