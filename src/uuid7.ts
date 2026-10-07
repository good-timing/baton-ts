import { randomBytes } from "node:crypto";

const COUNTER_MAX = 0xfff;

let lastMs = -1;
let counter = 0;

/** RFC 9562 UUIDv7, strictly increasing within this process: a 12-bit counter
 * orders ids minted in one millisecond, as the Python SDK's `_uuid.py` does. */
export function uuid7(): string {
  const bytes = randomBytes(18);
  // Seeded below half the counter's range, so a burst has room to count up.
  const seed = ((bytes[16]! << 8) | bytes[17]!) & 0x7ff;
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = seed;
  } else if (++counter > COUNTER_MAX) {
    lastMs += 1;
    counter = seed;
  }

  bytes.writeUIntBE(lastMs, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
