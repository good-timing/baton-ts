# Per-repo guidance for AI coding agents

*Follows the [AGENTS.md](https://agents.md) convention — discovered automatically by Claude Code, Cursor, OpenAI Codex CLI, and other AI coding agents.*

This is the TypeScript counterpart to [`baton`](https://github.com/good-timing/baton) (the Python `baton-sdk`). It has no `CHARTER.md` or `SPEC.md` of its own — **read `baton`'s `docs/CHARTER.md` and `docs/SPEC.md` first**; every boundary rule and ADR there applies here too. This file only adds what's TypeScript-specific.

## Status

Phase 1 scaffold (event types + sinks). The MCP interceptor that would let this package actually capture tool calls (`withBaton`, Phase 2) is not built — see the design note in `baton-internal` (private) for the phased plan. Don't add integration surface here without checking that plan first; the shape (tool-handler wrapping vs. middleware — the TS MCP SDK has no middleware API) is already researched.

## Wire compatibility — non-negotiable

Every event this package can construct must serialize to the same JSON shape the Python SDK produces (`baton`'s `src/baton/events.py`). The schema of record is `baton-spec` (submoduled at `baton-spec/`), not this repo's `src/events.ts` — if the two disagree, `baton-spec` wins and `src/events.ts` is wrong. `test/conformance.test.ts` enforces this against real Python-captured vectors; a change to `src/events.ts` that isn't schema-conformant should fail CI, not get waved through.

## Tooling

- Node 20+, TypeScript, `npm` (not pnpm/yarn — keep it boring)
- `tsup` for the dual ESM/CJS + `.d.ts` build
- `eslint` (flat config, `typescript-eslint` recommendedTypeChecked) for lint
- `vitest` for tests
- `zod` for runtime validation of the event schemas; `ajv` only in the conformance test, to check against `baton-spec/events.schema.json` independently of our own Zod definitions

Use `npm run ci` as the canonical gate (matches GitHub Actions).

## Boundary rules carried over from `baton` (Python)

1. No vendor-specific imports in `src/`. Same reasoning as the Python SDK — this package must work for any MCP server, not one vendor's.
2. No `console.*` in `src/` (`eslint.config.js` enforces this — mirrors Python's ruff `T20`). MCP stdio transport reserves stdout for JSON-RPC framing; use `StdoutSink` for anything that needs to reach a stream.
3. Public API is the contract. Anything exported from `src/index.ts` is what vendors integrate against once Phase 2 ships; breaking changes need the same `SPEC.md §13` changelog discipline as the Python SDK.
4. Tests use fake fixtures only (`ajv` against the schema, in-process fetch mocks for `HttpSink`) — no real vendor MCP server in this repo, ever.

## What lives where

- `src/events.ts` — Zod schemas + types for the event envelope and its five payload types.
- `src/sinks.ts` — `Sink` interface, `StdoutSink`, `HttpSink`.
- `src/version.ts` — `SDK_VERSION` (`"ts-0.1.0"` — TS-prefixed so the Console can tell TS- from Python-sourced events apart in `sdk_version`).
- `test/conformance.test.ts` — the wire-compatibility gate described above.
- `baton-spec/` — git submodule, schema of record. Never hand-edit; it's regenerated from `baton`'s Pydantic models.

## When in doubt

Read `baton`'s `docs/CHARTER.md` first. It's the North Star for this repo too.
