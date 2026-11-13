import { onWorkers } from "./runtime.js";

/** `process.emitWarning`, else a stderr line (`stderrLine`). On a Worker it is
 * `console.warn`, because a Worker prints nothing for `emitWarning`. Never
 * `console.log`: under stdio, stdout carries the MCP JSON-RPC frames. */
export function warn(message: string): void {
  if (onWorkers()) {
    // eslint-disable-next-line no-console -- console.warn writes to stderr, never to stdout
    console.warn(message);
    return;
  }
  try {
    if (typeof process !== "undefined" && typeof process.emitWarning === "function") return process.emitWarning(message);
  } catch {
    // A stand-in `emitWarning` that throws: Baton's own catch blocks call this.
  }
  stderrLine(message);
}

/** One line to stderr, or to `console.warn` where `process.stderr` is missing
 * or its write throws.
 * Never throws: it reports failures from inside Baton's own catch blocks. */
export function stderrLine(message: string): void {
  stderrLines([message]);
}

/** `lines` to stderr in one write, or each to `console.warn`. Never throws. */
export function stderrLines(lines: readonly string[]): void {
  try {
    // eslint-disable-next-line no-restricted-syntax -- this is the guarded read
    const stderr = typeof process !== "undefined" ? process.stderr : undefined;
    if (typeof stderr?.write === "function") return void stderr.write(lines.map((line) => `${line}\n`).join(""));
  } catch {
    // An ended or stand-in stderr: try `console.warn`.
  }
  for (const line of lines) {
    try {
      // eslint-disable-next-line no-console -- console.warn writes to stderr, never to stdout
      console.warn(line);
    } catch {
      // Nowhere left to report it.
    }
  }
}

/** `String(err)`, which throws for an object with no usable `toString`. */
export function printable(err: unknown): string {
  try {
    return String(err);
  } catch {
    return "(an error that cannot be printed)";
  }
}
