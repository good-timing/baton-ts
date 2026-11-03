import { nextClockSequence, nowMicros } from "../../sequence.js";

export const SESSION_CAP = 4096;

/** Per-session sequence numbers (SPEC §11.2 rule 5), for the
 * `SESSION_CAP` most recently used sessions. A minted session counts from 1;
 * an observed one is also at least the clock in µs, so its numbers still rise
 * after it is forgotten or when another process numbers the same session. */
export class SessionCounter {
  private readonly counters = new Map<string, number>();

  /** A per-call session is numbered by the clock: a counter would fill with
   * sessions that never come back and push out live ones. */
  nextFor(session: { sessionId: string; origin: "observed" | "minted"; perCall: boolean }): number {
    return session.perCall ? nextClockSequence() : this.next(session.sessionId, session.origin === "observed");
  }

  next(sessionId: string, observed: boolean): number {
    const previous = this.counters.get(sessionId) ?? 0;
    const next = observed ? Math.max(previous + 1, nowMicros()) : previous + 1;
    this.counters.delete(sessionId);
    this.counters.set(sessionId, next);
    if (this.counters.size > SESSION_CAP) this.counters.delete(this.counters.keys().next().value as string);
    return next;
  }
}

/** One server's counter: its own fallback session is numbered here, so the entry
 * goes with the server; every other session through the Baton's shared counter. */
export class ServerCounter extends SessionCounter {
  private ownSequence = 0;

  constructor(
    private readonly shared: SessionCounter,
    private readonly ownSessionId: string,
  ) {
    super();
  }

  override next(sessionId: string, observed: boolean): number {
    return sessionId === this.ownSessionId ? ++this.ownSequence : this.shared.next(sessionId, observed);
  }
}
