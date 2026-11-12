/** Whether this runs on Cloudflare Workers. `WebSocketPair` is there at
 * every compatibility date; `navigator` only from 2022-03-21. */
export function onWorkers(): boolean {
  return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function" ||
    (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");
}

/** The global `fetch`, looked up at each call. Called as a method, a
 * Worker's `fetch` throws "Illegal invocation". */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);
