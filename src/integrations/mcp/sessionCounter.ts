/**
 * Per-session monotonic sequence-number counter — mirrors `baton` (Python)'s
 * `_state.py::SessionCounter`. First call for a session returns 1.
 *
 * Python guards this with an `asyncio.Lock` because a single event loop can
 * still interleave two `await counter.next(...)` callers between the read
 * and the write of `self._counters[session_id]`. Node's single-threaded
 * event loop has the same hazard in principle, but `next()` here contains
 * no `await` — the read-increment-write is one synchronous turn, so it's
 * already atomic with respect to other JS execution. No lock needed.
 */
export class SessionCounter {
  private readonly counters = new Map<string, number>();

  next(sessionId: string): number {
    const current = this.counters.get(sessionId) ?? 0;
    const next = current + 1;
    this.counters.set(sessionId, next);
    return next;
  }
}
