// Multi-round-trip requests (protocol revision 2026-07-28): a paused round sends
// no terminal event and a resumed round no start, so the rounds are one call.

import { isRecord } from "../../_object.js";
import type { Extra } from "./mcpTypes.js";

/** Guarded like `isErrorResult`: it reads the vendor's result on the call path. */
export function isInputRequired(result: unknown): boolean {
  try {
    return isRecord(result) && result.resultType === "input_required";
  } catch {
    return false;
  }
}

/** `requestState` is an accessor the SDK sets on every request, so its value
 * is read, not its presence. */
export function resumesPausedCall(extra: Extra | undefined): boolean {
  try {
    const req = extra?.mcpReq;
    if (req === undefined) return false;
    return req.inputResponses !== undefined || req.requestState?.() !== undefined;
  } catch {
    return false;
  }
}
