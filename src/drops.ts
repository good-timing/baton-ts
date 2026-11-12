import { uuid7 } from "./uuid7.js";
import { warn } from "./warn.js";

/** Why an event was not delivered. Wire values (SPEC §11.2 rule 8), so they
 * change only with SPEC. */
export const DROP_REASONS = [
  "buffer_full",
  "refused",
  "encode_failed",
  "write_failed",
  "after_close",
  "unsent_at_close",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** The least time between two "delivering again" warnings, so steady loss
 * beside steady delivery, such as an overflowing buffer, is not one per event. */
const RECOVERY_LOG_MS = 60_000;

/** Events this process did not deliver, by reason: every event is either
 * delivered or counted here, except at close, where the count is best effort
 * (SPEC §11.2 rule 8). One per process, like the sequence clock. */
class DropCounts {
  // Made on first use: a Worker refuses random values while its modules load.
  #instanceId: string | undefined;
  readonly #total = new Map<DropReason, number>();
  readonly #sinceDelivery = new Map<DropReason, number>();
  #lastRecoveryLog = -RECOVERY_LOG_MS;

  add(reason: DropReason, n = 1): void {
    if (n <= 0) return;
    this.#total.set(reason, (this.#total.get(reason) ?? 0) + n);
    this.#sinceDelivery.set(reason, (this.#sinceDelivery.get(reason) ?? 0) + n);
  }

  total(): Partial<Record<DropReason, number>> {
    return Object.fromEntries(this.#total);
  }

  /** Called on each delivery: names what was lost before it, the other half of
   * a drop's own warning, which says only that loss started. */
  logRecovery(): void {
    if (this.#sinceDelivery.size === 0) return;
    const now = performance.now();
    if (now - this.#lastRecoveryLog < RECOVERY_LOG_MS) return;
    const lost = [...this.#sinceDelivery].sort(([a], [b]) => a.localeCompare(b));
    this.#sinceDelivery.clear();
    this.#lastRecoveryLog = now;
    const total = lost.reduce((sum, [, n]) => sum + n, 0);
    warn(`baton: delivering again; ${total} event(s) lost before this: ${lost.map(([r, n]) => `${r} ${n}`).join(", ")}.`);
  }

  /** Names this process in its loss reports (SPEC §11.4.7). */
  get instanceId(): string {
    return (this.#instanceId ??= uuid7());
  }

  /** For tests: the counts are one per process. */
  clear(): void {
    this.#instanceId = undefined;
    this.#total.clear();
    this.#sinceDelivery.clear();
    this.#lastRecoveryLog = -RECOVERY_LOG_MS;
  }
}

export const PROCESS_DROPS = new DropCounts();
