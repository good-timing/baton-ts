# Changelog

## Unreleased

- Phase 2 scaffold: `withBaton(server, config)` — capture-only MCP interceptor for `@modelcontextprotocol/sdk`'s `McpServer`. Wraps tool calls (registered before or after `withBaton` runs) and emits `tool_call_start`/`tool_call_end`/`tool_call_error`. In-process tests via `InMemoryTransport`.
- Phase 1 scaffold: event types (`src/events.ts`), `StdoutSink` + `HttpSink` (`src/sinks.ts`), `baton-spec` submodule + wire-conformance test.

**npm-publish blocker:** server `instructions` injection and the `<vendor>_annotate` tool are not implemented. Per CHARTER §5.1.2 these are a matched pair — instructions text exists to point the agent at the annotate tool, so shipping capture-only to real users would leave the annotation surface silently missing on instruction-aware runtimes. Do not `npm publish` until both land together. Tracked in the `sdk-hardening` thread, `baton-internal`.
