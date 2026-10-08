/** The envelope's `client_observed` (SPEC §11.4): what the client said about
 * itself, sent uninterpreted so the consumer computes the label. */

import { extraEnvelope, extraHeaders, extraMeta, type Extra } from "./mcpTypes.js";
import { cleanClientText, declaredClientInfo } from "./runtimeAdapter.js";

// The only headers ever copied. A request also carries credentials, so this
// is a list in the SDK and not a config option: `clientObserved.test.ts`,
// "never copies a header that is not registered".
const OBSERVED_HEADERS = ["user-agent", "x-anthropic-client"] as const;

export const HEADER_VALUE_MAX_LEN = 256;

export interface ClientObserved {
  info?: { name?: string; version?: string };
  headers?: Partial<Record<(typeof OBSERVED_HEADERS)[number], string>>;
}

/** `scrubber` is required so a call site cannot send these values unscrubbed
 * by leaving it out. */
export interface ObserveClientOptions {
  server?: unknown;
  scrubber: (value: unknown) => unknown;
}

/** `undefined` when nothing was observed, so the caller omits the key. Never
 * throws: it reads a third party's request and server objects. */
export function observeClient(
  extra: Extra,
  options: ObserveClientOptions,
): ClientObserved | undefined {
  try {
    const clean = (value: unknown, max?: number): string | null =>
      cleanClientText(value, options.scrubber, "client_observed", max);
    const observed: ClientObserved = {};

    const declared = declaredClientInfo(extraMeta(extra), {
      envelope: extraEnvelope(extra),
      server: options.server,
    });
    const info: NonNullable<ClientObserved["info"]> = {};
    const name = clean(declared?.name);
    const version = clean(declared?.version);
    if (name !== null) info.name = name;
    if (version !== null) info.version = version;
    if (Object.keys(info).length > 0) observed.info = info;

    const sent = extraHeaders(extra);
    const headers: NonNullable<ClientObserved["headers"]> = {};
    for (const header of OBSERVED_HEADERS) {
      const value = clean(sent?.get(header), HEADER_VALUE_MAX_LEN);
      if (value !== null) headers[header] = value;
    }
    if (Object.keys(headers).length > 0) observed.headers = headers;

    return Object.keys(observed).length > 0 ? observed : undefined;
  } catch {
    return undefined;
  }
}

/** Spread into an envelope: the key is absent, never `null`, when nothing was
 * observed. */
export function clientObservedMember(
  extra: Extra,
  options: ObserveClientOptions,
): { client_observed?: ClientObserved } {
  const observed = observeClient(extra, options);
  return observed === undefined ? {} : { client_observed: observed };
}
