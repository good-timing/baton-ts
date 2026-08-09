import type { Event } from "../../events.js";
import { safeWrite, type Sink } from "../../sinks.js";

/** Fail-open event construction + write. `build()` runs Zod validation —
 * a scrubber that breaks a payload's wire shape (e.g. replaces a record
 * wholesale) must not break the vendor's tool call any more than a sink
 * failure would; SPEC §11.2 fail-open applies to the whole capture step,
 * not just `sink.write`. */
export async function emit(sink: Sink, build: () => Event): Promise<void> {
  let event: Event;
  try {
    event = build();
  } catch (err) {
    process.stderr.write(`baton: event construction failed; event dropped: ${String(err)}\n`);
    return;
  }
  await safeWrite(sink, event);
}
