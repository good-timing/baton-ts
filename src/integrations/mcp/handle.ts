import { boundedSinkCall, type Sink } from "../../sinks.js";

/**
 * Handle returned from `withBaton` for graceful shutdown and session
 * correlation. Trimmed mirror of Python's `integrations/_handle.py::BatonHandle`
 * — `escalate()` is not here; it's a Console action-surface feature, out of
 * scope for this package.
 */
export class BatonHandle {
  /** The sink the vendor passed, or the default one. */
  readonly sink: Sink;
  readonly #queue: Sink;
  readonly vendorId: string;
  /** The install's own session id: what stdio and in-memory calls, and the
   * surface snapshot, carry when no session id resolves. A call over HTTP
   * with no session to read gets a per-request id instead (SPEC §3.4 rung 5). */
  readonly sessionId: string;
  /** The resolved annotation tool name: `BatonConfig.annotationToolName` if
   * set, else derived from the server's own name (`{slug}_annotate`), else
   * `{vendorId}_annotate`. */
  readonly annotationToolName: string;

  constructor(options: {
    sink: Sink;
    /** What Baton writes to, in front of `sink`. */
    queue?: Sink;
    vendorId: string;
    sessionId: string;
    annotationToolName: string;
  }) {
    this.sink = options.sink;
    this.#queue = options.queue ?? options.sink;
    this.vendorId = options.vendorId;
    this.sessionId = options.sessionId;
    this.annotationToolName = options.annotationToolName;
  }

  /** Flush any pending events held by the sink. Never rejects; returns within
   * the shutdown budget (SPEC §11.2 rule 7). */
  async flush(): Promise<void> {
    await boundedSinkCall(this.#queue, "flush");
  }

  /** Flush and release sink resources, on the same terms as `flush()`. */
  async aclose(): Promise<void> {
    await boundedSinkCall(this.#queue, "aclose");
  }
}
