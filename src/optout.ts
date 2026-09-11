/**
 * The off switch — one environment variable that stops Baton doing anything.
 *
 * `BATON_DISABLED=1`, and deliberately nothing else. Port of Python's
 * `baton/_optout.py`; `DO_NOT_TRACK` was built there and taken back OUT the
 * same day, on a measurement rather than an argument, so it is not here
 * either: **an MCP client does not hand its environment to the server it
 * spawns.** Both SDKs' clients pass a fixed allowlist — `HOME`, `LOGNAME`,
 * `PATH`, `SHELL`, `TERM`, `USER` — and `DO_NOT_TRACK` is not on it, so a
 * global export never reaches a wrapped stdio server, while a user editing
 * their client config's `env` block could have typed `BATON_DISABLED=1` there
 * instead. The cost was concrete where the benefit was not: a contributor with
 * it exported got a silently disabled SDK and 203 failing tests.
 *
 * **Off means INSTALL NOTHING, and it means NEVER THROW.** Not
 * capture-and-discard: no tool wrapping, no annotation tool on the surface, no
 * instructions rewrite, no sink, no buffer. The vendor's server starts and
 * behaves exactly as it would if `withBaton` were not in the file at all. Both
 * halves are load-bearing:
 *
 * - **Nothing on stdout, ever.** A stdio MCP server speaks JSON-RPC on stdout,
 *   so a courteous "Baton is disabled" line printed there corrupts the stream
 *   and breaks the server — in precisely the deployment shape this switch
 *   exists for.
 * - **The switch cannot break a server.** Every guard the SDK would otherwise
 *   throw from — a config missing its `vendorId`, an unparseable DSN — is
 *   skipped along with everything else, because a promise of "set this and
 *   Baton stops" that can still abort a boot is worse than no switch at all.
 *
 * ⚠ **The consequence of never-throw, recorded rather than argued away:** a
 * vendor whose CI exports `BATON_DISABLED` globally will not learn that their
 * `withBaton` call is malformed, because the call cannot fail while the switch
 * is on. It surfaces the first time capture is enabled.
 *
 * ⚠ **Read at install time, once, and never re-read.** A process that starts
 * with capture on keeps it on: this is a boot-time switch, not a live one. A
 * re-read per event would let a mid-flight environment change split one
 * session's events across two answers.
 *
 * ⚠ **Whose switch this is.** It belongs to whoever RUNS the server. For a
 * distributed stdio server that is the end user, and it works. For a HOSTED
 * server it is the vendor, and the end user has no switch at all — they cannot
 * set an environment variable on someone else's machine. A per-end-user
 * opt-out is the consent token (CHARTER ADR-1) and remains unbuilt, so no
 * vendor-facing wording may imply otherwise.
 */

import type { Sink } from "./sinks.js";

const SWITCH = "BATON_DISABLED";

// ⚠ **Permissive toward the opt-out, on purpose.** The documented form is
// `=1`, but someone who writes `BATON_DISABLED=true` has said what they want
// as plainly as someone who writes `1`, and the two failure directions are not
// symmetric: honouring an unintended opt-out costs some telemetry, while
// ignoring an intended one collects data from a person who asked us not to.
// So anything that is not an explicit "off" counts as on.
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
 * The NAME of the variable switching capture off, or `null`.
 *
 * The name rather than a boolean, so the log line and the disabled handle can
 * say what did it without every entry point repeating the string.
 *
 * The `process` read is guarded, like every other one in this package: it is
 * absent on edge and worker runtimes, and a missing `process` is "no switch
 * set", never a crash inside a vendor's server startup.
 */
export function captureDisabled(): string | null {
  const value = typeof process !== "undefined" ? process.env?.[SWITCH] : undefined;
  if (value !== undefined && !OFF_VALUES.has(value.trim().toLowerCase())) {
    return SWITCH;
  }
  return null;
}

/**
 * Say so once, on stderr, never on stdout.
 *
 * ⚠ **`process.emitWarning`, because `console` is BANNED in this package** —
 * `no-console` is an eslint error here, the coarse guard against the fatal
 * case: `console.log` writes to stdout, which is the JSON-RPC stream under
 * stdio transport. `console.error` would have been safe and was the first
 * cut, but carving an exception into a repo-wide rule for one line is worse
 * than using the channel the package already speaks on — `HttpSink`'s buffer
 * warning is the same call.
 *
 * ⚠ **Louder than the Python copy, and that is a divergence rather than an
 * oversight.** Python logs this at INFO, which its default handler drops, so a
 * server that configures no logging prints nothing; it argues explicitly
 * against WARNING, on the grounds that a line emitted every process start for
 * a switch somebody set deliberately teaches people to ignore warnings. That
 * argument is about a logger with levels to be quiet at, and this package has
 * none. The alternative was saying nothing at all, which loses the answer for
 * the vendor asking why no events arrive.
 *
 * ⚠ **Not a discoverability guarantee, and it must not be sold as one.** It is
 * for the vendor who goes looking. The answer for one who has not thought to
 * look is vendor-facing documentation, which is a different piece of work.
 */
export function logDisabled(switchName: string, surface: string): void {
  // Guarded like every `process` read in this package — absent on edge and
  // worker runtimes, where a missing warning channel must not crash a server's
  // startup. Deliberately NOT shared with `dsn.ts`'s `warn`: that one sweeps
  // credentials out of its message first, and this one has none to sweep.
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(
      `baton: ${switchName} is set, so capture is OFF — ${surface} installed ` +
        `nothing and will emit no events. Unset it to re-enable.`,
    );
  }
}

export class DisabledSink implements Sink {
  // The parameter is omitted rather than named-and-ignored: a narrower
  // signature satisfies `Sink` in TypeScript, and there is nothing to do with
  // an event that cannot arrive.
  async write(): Promise<void> {
    return;
  }

  async flush(): Promise<void> {
    return;
  }

  async aclose(): Promise<void> {
    return;
  }
}
