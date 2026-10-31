/** `process.emitWarning`, guarded like every `process` read in this package:
 * `console` is banned (stdout is the MCP JSON-RPC frame under stdio), and edge
 * runtimes have no `process` at all. */
export function warn(message: string): void {
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
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
