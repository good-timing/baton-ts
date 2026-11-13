/** Capture settings read from the collector (SPEC §2.6): fetch, match, apply.
 * The TypeScript half of Python's `_capture_settings.py`. */

import * as crypto from "node:crypto";
import { isRecord } from "../../_object.js";
import type { CaptureObserved } from "../../events.js";
import { globalFetch } from "../../runtime.js";
import { warn } from "../../warn.js";
import { RESULT_CAPTURE_MODES, type ResultCaptureMode } from "./errorResult.js";
import type { IntentParamMode } from "./schemaCompat.js";

export const SETTINGS_PATH = "/v0/settings";
export const TENANT_HEADER = "X-Baton-Tenant-Id";
export const SETTINGS_MODES = ["local", "console"] as const;
export type SettingsMode = (typeof SETTINGS_MODES)[number];
export const DEFAULT_SETTINGS_REFRESH_MS = 60_000;
export const MIN_SETTINGS_REFRESH_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type ReportMode = "on" | "off";
const MATCH_KEYS: ReadonlySet<string> = new Set(["label", "client", "share"]);
// Shared with the config check, so a mode the config takes is one a document can set.
export const INTENT_PARAM_MODES: ReadonlySet<string> = new Set(["optional", "required"]);
export const REPORT_MODES: ReadonlySet<string> = new Set(["on", "off"]);
// Derived from the registry, so no mode is accepted that the emitter has no payload shape for.
export const RESULT_CAPTURE_MODE_SET: ReadonlySet<string> = new Set(RESULT_CAPTURE_MODES);

/** What a `match` rule can see about one request. */
export interface Caller {
  labels: readonly string[];
  clientName: string | null;
  shareKey: string | null;
}

/** The settings one call runs under. An unset mode means the config's value. */
export interface CallSettings {
  capture: CaptureObserved;
  resultCaptureMode?: ResultCaptureMode;
  intentParamMode?: IntentParamMode;
  reportMode?: ReportMode;
}

export function shareBucket(vendorId: string, key: string): number {
  const digest = crypto.createHash("sha256").update(`${vendorId}\n${key}`, "utf-8").digest();
  return Number(digest.readBigUInt64BE(0) % 10000n);
}

/** One audience, its `match` checked once when the document is read. */
interface Audience {
  settings: CallSettings;
  labels: ReadonlySet<string> | null;
  clients: ReadonlySet<string> | null;
  shareThreshold: number | null;
}

function matchesEveryone(audience: Audience): boolean {
  return audience.labels === null && audience.clients === null && audience.shareThreshold === null;
}

function matches(audience: Audience, caller: Caller, bucket: number | null): boolean {
  if (audience.labels !== null && !caller.labels.some((label) => audience.labels!.has(label))) return false;
  if (audience.clients !== null && (caller.clientName === null || !audience.clients.has(caller.clientName))) {
    return false;
  }
  if (audience.shareThreshold !== null && (bucket === null || bucket >= audience.shareThreshold)) return false;
  return true;
}

export class SettingsDocument {
  private readonly usesShare: boolean;
  private readonly unmatched: CallSettings;
  /** Whether some caller can get reports, so the instructions point to the
   * tool. Read only where the code's value is "on": no tool exists otherwise. */
  readonly reportsOnForAnyone: boolean;

  constructor(
    readonly version: number,
    private readonly audiences: readonly Audience[],
  ) {
    this.usesShare = audiences.some((a) => a.shareThreshold !== null);
    this.unmatched = { capture: { settings_version: version } };
    // With no catch-all audience, a caller can fall through to the code's value.
    this.reportsOnForAnyone =
      audiences.some((a) => a.settings.reportMode !== "off") || !audiences.some(matchesEveryone);
  }

  settingsFor(caller: Caller, vendorId: string): CallSettings {
    const bucket = caller.shareKey !== null && this.usesShare ? shareBucket(vendorId, caller.shareKey) : null;
    return this.audiences.find((audience) => matches(audience, caller, bucket))?.settings ?? this.unmatched;
  }

}

function stringSet(value: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return new Set(value);
}

/** `null` for an audience that can match nobody (SPEC §2.6). */
function readAudience(
  version: number,
  id: string,
  match: Record<string, unknown>,
  capture: Record<string, unknown>,
): Audience | null {
  if (!Object.keys(match).every((key) => MATCH_KEYS.has(key))) return null;
  let labels: ReadonlySet<string> | null = null;
  let clients: ReadonlySet<string> | null = null;
  let shareThreshold: number | null = null;
  if (Object.hasOwn(match, "label") && (labels = stringSet(match.label)) === null) return null;
  if (Object.hasOwn(match, "client") && (clients = stringSet(match.client)) === null) return null;
  if (Object.hasOwn(match, "share")) {
    const share = match.share;
    if (typeof share !== "number" || !(share > 0 && share <= 1)) return null;
    // SPEC §2.6's formula, pinned by "a half rounds up".
    shareThreshold = Math.floor(share * 10000 + 0.5);
  }
  const settings: CallSettings = { capture: { settings_version: version, audience: id } };
  const { results, goal, reports } = capture;
  if (typeof results === "string" && RESULT_CAPTURE_MODE_SET.has(results)) {
    settings.resultCaptureMode = results as ResultCaptureMode;
  }
  if (typeof goal === "string" && INTENT_PARAM_MODES.has(goal)) settings.intentParamMode = goal as IntentParamMode;
  if (typeof reports === "string" && REPORT_MODES.has(reports)) settings.reportMode = reports as ReportMode;
  return { settings, labels, clients, shareThreshold };
}

/** The document in `body`, or `null` when it is not a valid one (SPEC §2.6). */
export function parseDocument(body: string): SettingsDocument | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const { version, audiences } = data;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (!Array.isArray(audiences) || audiences.length === 0) return null;
  const parsed: Audience[] = [];
  for (const audience of audiences) {
    if (!isRecord(audience)) return null;
    const { id, match, capture } = audience;
    if (typeof id !== "string" || !isRecord(match) || !isRecord(capture)) return null;
    const readable = readAudience(version, id, match, capture);
    if (readable !== null) parsed.push(readable);
  }
  return new SettingsDocument(version, parsed);
}

/** Where `CaptureSettings` gets its document: the fetcher, or a test's stand-in. */
export interface SettingsSource {
  readonly document: SettingsDocument | null;
  start(): void;
  stop(): void;
}

export interface SettingsFetcherOptions {
  origin: string;
  apiKey: string;
  tenantId: string;
  vendorId: string;
  refreshMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Reads the document in the background and holds the last good one. A call
 * never waits on it. */
export class SettingsFetcher implements SettingsSource {
  private readonly url: string;
  // `#`, not `private`, so logging a config shows no key: "logging the config shows no key".
  readonly #headers: Record<string, string>;
  private readonly refreshMs: number;
  private readonly fetchImpl: typeof fetch;
  private etag: string | null = null;
  private held: SettingsDocument | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading: AbortController | null = null;
  private warned = false;

  constructor(options: SettingsFetcherOptions) {
    this.url = `${options.origin}${SETTINGS_PATH}?${new URLSearchParams({ server: options.vendorId }).toString()}`;
    this.#headers = { Authorization: `Bearer ${options.apiKey}`, [TENANT_HEADER]: options.tenantId };
    this.refreshMs = options.refreshMs;
    this.fetchImpl = options.fetchImpl ?? globalFetch;
  }

  get document(): SettingsDocument | null {
    return this.held;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.readOnce(), this.refreshMs);
    // The read must not keep a vendor's process alive.
    (this.timer as { unref?: () => void }).unref?.();
    void this.readOnce();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.reading?.abort();
    this.reading = null;
  }

  /** One request. Never rejects: a failure keeps what is held. */
  async readOnce(): Promise<void> {
    if (this.reading !== null) return;
    const reading = new AbortController();
    this.reading = reading;
    const timeout = setTimeout(() => reading.abort(), REQUEST_TIMEOUT_MS);
    (timeout as { unref?: () => void }).unref?.();
    try {
      await this.read(reading.signal);
    } catch {
      // Kept quiet: the collector being down must not fill the vendor's logs.
    } finally {
      clearTimeout(timeout);
      if (this.reading === reading) this.reading = null;
    }
  }

  private async read(signal: AbortSignal): Promise<void> {
    const headers = this.etag === null ? this.#headers : { ...this.#headers, "If-None-Match": this.etag };
    const response = await this.fetchImpl(this.url, { method: "GET", headers, redirect: "manual", signal });
    if (response.status !== 200) {
      // An unread body holds its connection until GC.
      void response.body?.cancel().catch(() => undefined);
    }
    // An answer that lands after `stop()` is dropped.
    if (signal.aborted) return;
    if (response.status === 204) {
      this.held = null;
      this.etag = null;
    } else if (response.status === 200) {
      const document = parseDocument(await response.text());
      if (signal.aborted) return;
      if (document === null) {
        if (!this.warned) {
          this.warned = true;
          warn("baton: the collector sent capture settings this SDK cannot read");
        }
        return;
      }
      this.held = document;
      this.etag = response.headers.get("etag");
    }
  }
}

/** Per-call settings from the matched audience (SPEC §2.6). */
export class CaptureSettings {
  constructor(
    private readonly vendorId: string,
    private readonly source: SettingsSource,
  ) {}

  start(): void {
    this.source.start();
  }

  stop(): void {
    this.source.stop();
  }

  get document(): SettingsDocument | null {
    return this.source.document;
  }

  /** `undefined` while no document is held, and the config's values apply. */
  forCaller(caller: Caller): CallSettings | undefined {
    return this.document?.settingsFor(caller, this.vendorId);
  }
}
