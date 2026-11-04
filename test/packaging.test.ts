/**
 * The cheap half of "this package installs for a vendor who has only one SDK
 * major". The real proof is a pack-and-install into a tree carrying only v2
 * (see CHANGELOG); this is the guard that keeps it true afterwards, because
 * the way it regresses is somebody adding one convenient `import type` and
 * every existing test staying green — the failure only shows up in a
 * consumer's install, which is nobody's inner loop.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { EventTypeSchema } from "../src/events.js";

const SRC = new URL("../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

describe("public surface", () => {
  // From 1.0 removing any of these is a 2.0, and adding one is a promise.
  it("exports exactly these values", async () => {
    const api = await import("../src/index.js");
    expect(Object.keys(api).sort()).toEqual([
      "BatonHandle",
      "Client",
      "EventSchema",
      "FileSink",
      "HttpSink",
      "INTENT_INSTRUCTIONS",
      "INTENT_PARAMS",
      "MultiSink",
      "SDK_VERSION",
      "Scrubber",
      "SinkClosedError",
      "StdoutSink",
      "Trace",
      "createBaton",
      "identityScrub",
      "principalFromOAuthEmail",
      "principalFromOAuthSub",
      "withBaton",
    ]);
  });

  /** Read from the compiler, so it covers type exports too, which leave no
   * runtime key. The event types are derived from `EventTypeSchema`, so a new
   * event type must be exported by existing: the rolled-up `dist/index.d.ts`
   * carries a type `Event` names, but without `export`, so nothing else fails. */
  it("exports exactly these names, values and types", () => {
    const index = join(SRC, "index.ts");
    const program = ts.createProgram([index], { module: ts.ModuleKind.NodeNext, noEmit: true });
    const checker = program.getTypeChecker();
    const module = checker.getSymbolAtLocation(program.getSourceFile(index)!)!;
    const pascal = (type: string): string =>
      type
        .split("_")
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");
    const eventTypes = EventTypeSchema.options.flatMap((type) => [
      `${pascal(type)}Event`,
      `${pascal(type)}Payload`,
    ]);
    const names = checker.getExportsOfModule(module).map((symbol) => symbol.name);
    expect(names.sort()).toEqual(
      [
        ...eventTypes,
        "AnnotateOptions",
        "AuthInfo",
        "Baton",
        "BatonConfig",
        "BatonHandle",
        "Client",
        "ClientOptions",
        "Event",
        "EventSchema",
        "EventType",
        "FileSink",
        "HeaderInput",
        "HttpSink",
        "HttpSinkOptions",
        "INTENT_INSTRUCTIONS",
        "INTENT_PARAMS",
        "IntentParam",
        "ListToolsOptions",
        "MultiSink",
        "ObservedError",
        "Organization",
        "Principal",
        "PrincipalForm",
        "PrincipalResolutionContext",
        "ResolvePrincipalHook",
        "ResultCaptureMode",
        "SDK_VERSION",
        "Scrubber",
        "SessionOptions",
        "Sink",
        "SinkClosedError",
        "StdoutSink",
        "StdoutSinkOptions",
        "SupportedMcpServer",
        "Trace",
        "TraceOptions",
        "createBaton",
        "identityScrub",
        "principalFromOAuthEmail",
        "principalFromOAuthSub",
        "withBaton",
      ].sort(),
    );
  });
});

describe("packaging", () => {
  it("no module under src/ imports either SDK major, as a value OR as a type", () => {
    // A type-only import is erased from the JS but survives into
    // `dist/index.d.ts` via tsup's declaration rollup, where it breaks a
    // consumer's `tsc` just as hard as a missing runtime module breaks their
    // `node`. Both are peerDependencies, both optional; neither is imported.
    // Matched over the WHOLE file, not line by line: multi-line
    //     import type {
    //       RegisteredTool,
    //     } from "@modelcontextprotocol/sdk/server/mcp.js";
    // is the house style here and appears on no single line. `[^;]` spans
    // newlines while the `;` stops the match crossing into a later
    // statement, and the line anchor skips JSDoc examples, which start `*`.
    const patterns = [
      /^[ \t]*(?:import|export)[^;]*?from\s*["']@modelcontextprotocol/m,
      /^[ \t]*import\s*["']@modelcontextprotocol/m,
    ];
    const offenders = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, "utf-8");
      return patterns.some((p) => p.test(text));
    });

    expect(offenders).toEqual([]);
  });
});
