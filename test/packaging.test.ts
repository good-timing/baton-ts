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
  /** Every event type the SDK can emit has its schema and its two types
   * EXPORTED from `src/index.ts`.
   *
   * ⚠ **Derived from `EventTypeSchema`, so a new event type acquires this
   * requirement by existing.** The way this regresses is the way it already
   * did twice: the rolled-up `dist/index.d.ts` carries a type transitively
   * whenever `Event` references it, but WITHOUT `export` — so `tsc` is green,
   * every test is green, and the only person who finds out is a vendor trying
   * to name it. `ResultCaptureMode` cost `f1b7ab2` exactly that way, and the
   * twelve lifecycle types cost it again one commit after they landed.
   *
   * Read as TEXT rather than by importing `index.js` and checking keys,
   * because a TYPE export leaves no runtime key to check — and the types are
   * half of what a vendor needs. */
  it("exports a schema and both types for every event type in the enum", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const pascal = (type: string): string =>
      type
        .split("_")
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");
    const missing = EventTypeSchema.options.flatMap((type) => {
      const base = pascal(type);
      return [`${base}Event`, `${base}Payload`, `${base}EventSchema`, `${base}PayloadSchema`].filter(
        (name) => !new RegExp(`^\\s*${name},$`, "m").test(index),
      );
    });
    expect(missing).toEqual([]);
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
