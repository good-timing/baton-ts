/**
 * Tracks which sessions have already emitted a proactive annotation —
 * mirrors `baton` (Python)'s `_state.py::ProactiveTracker`. Coordinates the
 * two proactive sources so a session opens at most one: `withBaton`'s tool
 * wrapper synthesises a proactive from the first injected `user_goal` it
 * sees, and the annotation tool marks the slot claimed when the agent calls
 * it proactively itself (`signal_type` omitted). On instruction-aware
 * runtimes both paths can fire; on Claude Desktop only the injected-param
 * path does.
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

  /** Mark the slot claimed without emitting here (the annotation tool's own
   * handler already emitted the annotation event itself). */
  mark(sessionId: string): void {
    this.emitted.add(sessionId);
  }
}
