let lastSequence = 0;

export function nowMicros(): number {
  return Math.floor((performance.timeOrigin + performance.now()) * 1000);
}

/** Sequence numbers from the clock, in microseconds (SPEC §5.6 rule 3). One
 * counter for the process: strictly increasing across all sessions is
 * strictly increasing within each, and nothing grows per session. */
export function nextClockSequence(): number {
  lastSequence = Math.max(lastSequence + 1, nowMicros());
  return lastSequence;
}
