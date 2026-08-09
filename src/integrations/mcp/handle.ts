import type { Sink } from "../../sinks.js";

/**
 * Handle returned from `withBaton` for graceful shutdown and session
 * correlation. Trimmed mirror of Python's `integrations/_handle.py::BatonHandle`
 * — `escalate()` is not here; it's a Console action-surface feature, out of
 * scope for this capture-only scaffold same as the annotation tool.
 */
export class BatonHandle {
  readonly sink: Sink;
  readonly vendorId: string;
  /** Process-lifetime fallback session id — the value events fall back to
   * when no real per-call session id resolves. Not every event necessarily
   * carries this id; see `withBaton`'s session-resolution order. */
  readonly sessionId: string;

  constructor(options: { sink: Sink; vendorId: string; sessionId: string }) {
    this.sink = options.sink;
    this.vendorId = options.vendorId;
    this.sessionId = options.sessionId;
  }

  /** Flush any pending events held by the sink. */
  async flush(): Promise<void> {
    await this.sink.flush();
  }

  /** Flush and release sink resources. Subsequent writes reject. */
  async aclose(): Promise<void> {
    await this.sink.aclose();
  }
}
