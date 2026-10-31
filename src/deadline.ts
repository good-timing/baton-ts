import { warn } from "./warn.js";

export const TIMED_OUT = Symbol("timedOut");

/** `work`'s result, or `TIMED_OUT` if it has not settled within `ms`. */
export async function raceDeadline<T>(work: PromiseLike<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // A pending deadline must not hold a finished process open. Outside Node a
    // timer is a number with no `unref`: `principalResolution.test.ts`,
    // "where a timer is a plain number".
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** SPEC §11.2 rule 7's budget for a flush at exit, or an explicit flush or close. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 3000;

/** Run a sink's flush or close for the vendor: never rejects, and returns
 * within `ms`. A sink that keeps its own budget (`HttpSink`) is given a little
 * longer, so its own warning, which counts what was left, is the one shown. */
export async function boundedSinkCall(work: () => Promise<unknown>, what: string, ms = SHUTDOWN_FLUSH_TIMEOUT_MS + 250): Promise<void> {
  let started: Promise<unknown>;
  try {
    started = work();
  } catch (err) {
    warn(`baton: ${what} failed: ${String(err)}`);
    return;
  }
  const settled = started.then(
    () => undefined,
    (err: unknown) => warn(`baton: ${what} failed: ${String(err)}`),
  );
  if ((await raceDeadline(settled, ms)) === TIMED_OUT) {
    warn(`baton: ${what} took over ${String(ms)} ms and was left unfinished.`);
  }
}
