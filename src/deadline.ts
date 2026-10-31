export const TIMED_OUT = Symbol("timedOut");

/** Larger values overflow Node's timer, which then fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** `work`'s result, or `TIMED_OUT` if it has not settled within `ms`. */
export async function raceDeadline<T>(work: PromiseLike<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.min(ms, MAX_TIMER_MS));
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
