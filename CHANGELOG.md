# Changelog

## Unreleased

- Instructions + annotation tool: `withBaton` now injects server `instructions` (SPEC §5.1.2) and registers the `<vendor>_annotate` tool (SPEC §5.1.1). Templates are a byte-for-byte port of Python's `integrations/_llm_text.py` — verified by rendering both sides with identical inputs and diffing. `BatonConfig` gains a required `vendorDisplayName` and an optional `annotationToolName` override. This clears the npm-publish blocker below — **the instructions+annotate-tool pair is no longer missing.**
- Phase 2 scaffold: `withBaton(server, config)` — MCP interceptor for `@modelcontextprotocol/sdk`'s `McpServer`. Wraps tool calls (registered before or after `withBaton` runs) and emits `tool_call_start`/`tool_call_end`/`tool_call_error`. In-process tests via `InMemoryTransport`.
- Phase 1 scaffold: event types (`src/events.ts`), `StdoutSink` + `HttpSink` (`src/sinks.ts`), `baton-spec` submodule + wire-conformance test.

**Remaining gaps before a real `npm publish`** (not hard blockers the way the instructions+annotate pair was — see README "What's deferred"): intent-param injection (`user_goal`/`expected_result`), `surface_snapshot` capture, a real PII scrub-rule implementation, and the design note's Phase 3 (stricter cross-SDK wire-diff test) / Phase 4 (fork a real OSS server, run a live demo session) readiness work. Tracked in the `sdk-hardening` thread, `baton-internal`.
