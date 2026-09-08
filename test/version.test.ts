/**
 * `SDK_VERSION` and `package.json`'s version are two hand-maintained spellings
 * of one number, and nothing else connects them.
 *
 * The drift is silent in the direction that matters: bumping `package.json`
 * for a release without touching `version.ts` publishes a package whose every
 * event reports the PREVIOUS version in `sdk_version` — the field the Console
 * uses to tell TypeScript-sourced events from Python ones, and the first thing
 * anyone reads when deciding whether a fix is live in a customer's install.
 * The build succeeds, the tests pass, and the number is wrong everywhere it is
 * consumed. Found while cutting 0.2.0, one step before shipping exactly that.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SDK_VERSION } from "../src/version.js";

describe("SDK_VERSION", () => {
  it("matches package.json, with the `ts-` prefix that marks the producer", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(SDK_VERSION).toBe(`ts-${pkg.version}`);
  });
});
