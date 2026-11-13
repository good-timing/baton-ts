/** Whether this runs on Cloudflare Workers. `WebSocketPair` is there at
 * every compatibility date; `navigator` only from 2022-03-21. */
export function onWorkers(): boolean {
  return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function" ||
    (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");
}

/** The global `fetch`, looked up at each call. Called as a method, a
 * Worker's `fetch` throws "Illegal invocation". */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/** Adds `listener` for `event` to `process`, and returns what takes it off
 * that same `process`, which a test may since have swapped for a stand-in.
 * `undefined` where `process` takes no listeners, as on an edge runtime. */
export function onProcess(event: "beforeExit" | "exit", listener: () => void): (() => void) | undefined {
  const target = typeof process !== "undefined" ? process : undefined;
  if (typeof target?.on !== "function") return undefined;
  try {
    target.on(event, listener);
  } catch {
    return undefined;
  }
  return () => {
    try {
      target.off(event, listener);
    } catch {
      // A stand-in with `on` and no working `off`: nothing more to take off.
    }
  };
}
