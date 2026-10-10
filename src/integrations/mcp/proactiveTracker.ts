/**
 * Tracks which sessions have already emitted a proactive annotation —
 * the counterpart of `baton` (Python)'s `_state.py::ProactiveTracker`.
 * `withBaton`'s tool wrapper synthesises one from the first injected
 * `user_goal` a session carries, and this keeps it to one per session. The
 * annotation tool takes reports only, so it never claims the slot.
 *
 * Synchronous, mutating a plain `Set` — safe with no lock because Node's
 * single-threaded event loop never interleaves two synchronous calls here.
 */
export class ProactiveTracker {
  private readonly emitted = new Set<string>();

  /** Claim the session's proactive slot. Returns true exactly once per
   * session (the caller should then emit); false if already claimed. */
  claim(sessionId: string): boolean {
    if (this.emitted.has(sessionId)) return false;
    this.emitted.add(sessionId);
    return true;
  }
}
