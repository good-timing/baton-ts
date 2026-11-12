import { onWorkers } from "./runtime.js";

/** `process.emitWarning`, guarded like every `process` read in this package:
 * `console` is banned (stdout is the MCP JSON-RPC frame under stdio), and edge
 * runtimes have no `process` at all. A Worker has no stdio and prints nothing
 * for `emitWarning`, so there it is `console.warn`. */
export function warn(message: string): void {
  if (onWorkers()) {
    // eslint-disable-next-line no-console -- a Worker has no stdio to corrupt
    console.warn(message);
  } else if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(message);
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
