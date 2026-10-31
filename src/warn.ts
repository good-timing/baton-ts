/** `process.emitWarning`, guarded like every `process` read in this package:
 * `console` is banned (stdout is the MCP JSON-RPC frame under stdio), and edge
 * runtimes have no `process` at all. */
export function warn(message: string): void {
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(message);
  }
}
