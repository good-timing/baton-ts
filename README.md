# @baton/sdk (TypeScript)

*The TypeScript counterpart to [`baton-sdk`](https://github.com/good-timing/baton) (Python) — structured signal capture for agent-mediated tool use over MCP.*

**Status: pre-publish.** `withBaton` instruments an `@modelcontextprotocol/sdk` `McpServer`: wraps every tool call, injects server `instructions`, and registers the `<vendor>_annotate` tool (SPEC §5.1.1–§5.1.2). It does **not** yet do what Python's `install_baton(mcp, ...)` does beyond that — no intent-param injection, no `surface_snapshot`. That's a deliberate scope cut, not an oversight — see [What's deferred](#whats-deferred). Not yet published to npm.

## Why this exists

Most production MCP servers are TypeScript, not Python — see the [design note](https://github.com/good-timing/baton-internal) (private) for the motivating research. `baton-sdk` (Python) can't reach that half of the ecosystem. This package is the TS-native way in, wire-compatible with the Python SDK by construction (see [Wire compatibility](#wire-compatibility) below).

## What's here

- `Event` — a Zod-validated discriminated union over the five event types (`tool_call_start`, `tool_call_end`, `tool_call_error`, `annotation`, `surface_snapshot`), field-for-field with the Python SDK's Pydantic models.
- `StdoutSink` — JSONL to a writable stream (default `process.stderr` — MCP stdio transport reserves stdout for JSON-RPC framing).
- `HttpSink` — `POST {url}/v0/events` with bearer auth, bounded buffer, retry with backoff, circuit breaker. The contract any Baton-compatible collector consumes.
- `withBaton(server, config)` — wraps every tool call on an `@modelcontextprotocol/sdk` `McpServer` (peer dependency) and emits `tool_call_start` / `tool_call_end` / `tool_call_error`. Works regardless of whether tools are registered before or after `withBaton` runs (see the module docstring in `src/integrations/mcp/withBaton.ts` for why that ordering independence is load-bearing, not incidental). Also injects server `instructions` and registers the `<vendor>_annotate` tool so the calling agent can supply structured intent/outcome/friction signal — same behavioral contract as Python's adapters, ported byte-for-byte (verified against the Python SDK's actual rendered output, not just eyeballed).

`FileSink` / `MultiSink` are deliberately not here yet — see [What's deferred](#whats-deferred).

## What's deferred

Intent-param injection (`user_goal`/`expected_result` — captures intent on runtimes that drop `instructions`, notably Claude Desktop) and `surface_snapshot` capture are not here. Also deferred: the low-level `Server` adapter (only the high-level `McpServer` is supported), and a real PII scrub-rule implementation (the `scrubber` hook exists; it's identity by default, same gap as core). None of these block `npm publish` the way the instructions+annotate-tool pair did — that pair has shipped (see CHANGELOG.md).

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
