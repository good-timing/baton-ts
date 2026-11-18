/** Capture settings read from the collector (SPEC §2.6): fetch, match, apply.
 * The TypeScript half of Python's `_capture_settings.py`. */

import * as crypto from "node:crypto";
import { isRecord } from "../../_object.js";
import { stripWhiteSpace } from "../../_text.js";
import type { CaptureObserved } from "../../events.js";
import { TIMED_OUT, raceDeadline } from "../../deadline.js";
import { globalFetch } from "../../runtime.js";
import { warn } from "../../warn.js";
import { RESULT_CAPTURE_MODES, type ResultCaptureMode } from "./errorResult.js";
import { type Overlay, overlayFor, readOverlays } from "./overlays.js";
import type { IntentParamMode } from "./schemaCompat.js";

export const SETTINGS_PATH = "/v0/settings";
export const TENANT_HEADER = "X-Baton-Tenant-Id";
export const SETTINGS_MODES = ["local", "console"] as const;
export type SettingsMode = (typeof SETTINGS_MODES)[number];
export const DEFAULT_SETTINGS_REFRESH_MS = 60_000;
export const MIN_SETTINGS_REFRESH_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

export const CANDIDATE_ENV = "BATON_CANDIDATE";
export const CANDIDATE_HEADER = "baton-candidate";
export const CANDIDATES_HELD = 32;
export const CANDIDATE_READS_AT_ONCE = 4;
export const CANDIDATE_START_TIMEOUT_MS = 5_000;
// The header is the caller's: it becomes a query value and a cache key.
const CANDIDATE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const TASK_ENV = "BATON_TASK";
export const TASK_HEADER = "baton-task";
const TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function matchingId(pattern: RegExp, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = stripWhiteSpace(value);
  return pattern.test(id) ? id : null;
}

function headerId(headers: Headers | null, name: string, parse: (value: unknown) => string | null): string | null {
  try {
    return parse(headers?.get(name));
  } catch {
    return null;
  }
}

/** `value` as a change id, stripped, or `null` when it cannot be one. */
export function candidateId(value: unknown): string | null {
  return matchingId(CANDIDATE_ID, value);
}

/** The `Baton-Candidate` header's change id. Never throws. */
export function headerCandidate(headers: Headers | null): string | null {
  return headerId(headers, CANDIDATE_HEADER, candidateId);
}

/** `value` as a test run's task id, stripped, or `null` when it cannot be one. */
export function taskId(value: unknown): string | null {
  return matchingId(TASK_ID, value);
}

/** The `Baton-Task` header's task id. Never throws. */
export function headerTask(headers: Headers | null): string | null {
  return headerId(headers, TASK_HEADER, taskId);
}

/** `BATON_TASK`; a value that cannot be a task id is dropped. */
export function envTask(): string | null {
  return taskId(typeof process !== "undefined" ? process.env?.[TASK_ENV] : undefined);
}

/** `BATON_CANDIDATE`, or `null` when unset. A value that cannot be an id is reported. */
export function envCandidate(): string | null {
  const value = typeof process !== "undefined" ? process.env?.[CANDIDATE_ENV] : undefined;
  if (!value) return null;
  const id = candidateId(value);
  if (id === null) warn(`baton: ${CANDIDATE_ENV} is not a change id; today's settings apply.`);
  return id;
}

/** `BATON_CANDIDATE` is read only with Console settings; said loudly, since a
 * test run would otherwise measure today's text. */
export function candidateNeedsConsole(settings: SettingsMode | undefined): void {
  if (settings !== "console" && envCandidate() !== null) {
    warn(
      `baton: ${CANDIDATE_ENV} is set, but this server's settings are not "console", ` +
        "so the change is not fetched; today's settings apply.",
    );
  }
}

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
  /** From the request's headers: `candidate` selects a document, never an
   * audience; `task` only tags the events served under it. */
  candidate?: string | null;
  task?: string | null;
}

/** The settings one call runs under. An unset mode means the config's value. */
export interface CallSettings {
  capture: CaptureObserved;
  resultCaptureMode?: ResultCaptureMode;
  intentParamMode?: IntentParamMode;
  reportMode?: ReportMode;
  overlay?: Overlay;
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
  /** The tools some audience's overlay hides. */
  readonly hiddenSomewhere: ReadonlySet<string>;
  /** The pieces of Baton's text some audience's overlay changes. */
  readonly audiencePieces: ReadonlySet<string>;

  constructor(
    readonly version: number,
    private readonly audiences: readonly Audience[],
    readonly serverOverlay?: Overlay,
    candidate?: string,
  ) {
    const overlays = audiences.flatMap((a) => (a.settings.overlay === undefined ? [] : [a.settings.overlay]));
    this.hiddenSomewhere = new Set(overlays.flatMap((o) => [...o.hiddenTools]));
    this.audiencePieces = new Set(overlays.flatMap((o) => o.actions.flatMap((a) => (a.piece === undefined ? [] : [a.piece]))));
    this.usesShare = audiences.some((a) => a.shareThreshold !== null);
    this.unmatched = { capture: { settings_version: version, ...(candidate === undefined ? {} : { candidate }) } };
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
  overlay: Overlay | undefined,
  candidate: string | undefined,
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
  const settings: CallSettings = {
    capture: {
      settings_version: version,
      audience: id,
      ...(overlay === undefined ? {} : { overlay: overlay.id }),
      ...(candidate === undefined ? {} : { candidate }),
    },
  };
  if (overlay !== undefined) settings.overlay = overlay;
  const { results, goal, reports } = capture;
  if (typeof results === "string" && RESULT_CAPTURE_MODE_SET.has(results)) {
    settings.resultCaptureMode = results as ResultCaptureMode;
  }
  if (typeof goal === "string" && INTENT_PARAM_MODES.has(goal)) settings.intentParamMode = goal as IntentParamMode;
  if (typeof reports === "string" && REPORT_MODES.has(reports)) settings.reportMode = reports as ReportMode;
  return { settings, labels, clients, shareThreshold };
}

/** The document in `body`, or `null` when it is not a valid one (SPEC §2.6).
 * With `candidate`, valid only when it names that change. */
export function parseDocument(body: string, candidate?: string): SettingsDocument | null {
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
  if (candidate !== undefined && data.candidate !== candidate) return null;
  const overlays = readOverlays(data.overlays);
  const parsed: Audience[] = [];
  for (const audience of audiences) {
    if (!isRecord(audience)) return null;
    const { id, match, capture } = audience;
    if (typeof id !== "string" || !isRecord(match) || !isRecord(capture)) return null;
    const overlay = overlayFor(overlays, audience.overlay, "audience");
    const readable = readAudience(version, id, match, capture, overlay, candidate);
    if (readable !== null) parsed.push(readable);
  }
  return new SettingsDocument(version, parsed, overlayFor(overlays, data.server_overlay, "server"), candidate);
}

/** Where `CaptureSettings` gets its document: the fetcher, or a test's stand-in. */
export interface SettingsSource {
  readonly document: SettingsDocument | null;
  start(): void;
  stop(): void;
  /** One read of change `candidate`. Never rejects. */
  fetchCandidate(candidate: string, timeoutMs: number): Promise<CandidateRead>;
}

export type CandidateRead =
  | { outcome: "loaded"; document: SettingsDocument }
  | { outcome: "refused" | "unknown" | "failed" };

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
  private readonly candidateReads = new Set<AbortController>();
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
    for (const read of this.candidateReads) read.abort();
  }

  async fetchCandidate(candidate: string, timeoutMs: number): Promise<CandidateRead> {
    const reading = new AbortController();
    const timeout = setTimeout(() => reading.abort(), timeoutMs);
    (timeout as { unref?: () => void }).unref?.();
    this.candidateReads.add(reading);
    try {
      const url = `${this.url}&${new URLSearchParams({ candidate }).toString()}`;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.#headers,
        redirect: "manual",
        signal: reading.signal,
      });
      if (response.status !== 200) void response.body?.cancel().catch(() => undefined);
      if (response.status === 403) return { outcome: "refused" };
      if (response.status === 404) return { outcome: "unknown" };
      if (response.status === 200) {
        const document = parseDocument(await response.text(), candidate);
        if (document !== null) return { outcome: "loaded", document };
      }
    } catch {
      // A failed read is tried again later.
    } finally {
      clearTimeout(timeout);
      this.candidateReads.delete(reading);
    }
    return { outcome: "failed" };
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

const PENDING = Symbol("pending");

/** Per-call settings from the matched audience (SPEC §2.6), and the test
 * changes a test key may fetch by id: `BATON_CANDIDATE` for the process, the
 * `Baton-Candidate` header for one HTTP request, which wins. */
export class CaptureSettings {
  private processDocument: SettingsDocument | null = null;
  /** `BATON_CANDIDATE`'s read; requests wait for it. */
  ready: Promise<void> = Promise.resolve();
  isReady = true;
  // id -> its document, `null` for an unknown id, `PENDING`, or the time a failed read may be tried again.
  private readonly held = new Map<string, SettingsDocument | null | typeof PENDING | number>();
  // A 403 is about the key, so it answers every id for this process.
  private refused = false;
  private stopped = false;
  retryAfterMs = REQUEST_TIMEOUT_MS;

  constructor(
    private readonly vendorId: string,
    private readonly source: SettingsSource,
    private readonly candidate: string | null = null,
    private readonly task: string | null = null,
    private readonly startTimeoutMs = CANDIDATE_START_TIMEOUT_MS,
  ) {}

  start(): void {
    const candidate = this.candidate;
    if (candidate !== null && this.processDocument === null) {
      const cannotLoad = (why: string): void =>
        warn(`baton: ${CANDIDATE_ENV}=${candidate} could not be loaded (${why}); today's settings apply.`);
      const fetched = this.source.fetchCandidate(candidate, this.startTimeoutMs);
      this.isReady = false;
      // Bounded here too, so a fetch that ignores its signal cannot hold up requests.
      this.ready = raceDeadline(fetched, this.startTimeoutMs).then((read) => {
        this.isReady = true;
        if (this.stopped) return;
        if (read === TIMED_OUT) {
          cannotLoad("no answer");
          // A late answer is never served, so a run sees one set of settings;
          // a 403 still says the key is the cause.
          void fetched.then((late) => {
            if (!this.stopped && late.outcome === "refused") this.record(candidate, late);
          });
          return;
        }
        this.record(candidate, read);
        if (read.outcome === "loaded") this.processDocument = read.document;
        else if (read.outcome !== "refused") cannotLoad(read.outcome === "unknown" ? "unknown id" : "no answer");
      });
    }
    this.source.start();
  }

  stop(): void {
    this.stopped = true;
    this.source.stop();
  }

  /** The document for a request with no header of its own. */
  get document(): SettingsDocument | null {
    return this.processDocument ?? this.source.document;
  }

  /** `undefined` while no document is held, and the config's values apply. */
  forCaller(caller: Caller): CallSettings | undefined {
    const document =
      caller.candidate == null ? this.document : (this.headerDocument(caller.candidate) ?? this.source.document);
    const settings = document?.settingsFor(caller, this.vendorId);
    const task = caller.candidate == null ? this.task : caller.task;
    if (settings === undefined || task == null || settings.capture.candidate === undefined) return settings;
    return { ...settings, capture: { ...settings.capture, task } };
  }

  /** Whether `test` holds for some document a request could be served under now. */
  someDocument(test: (document: SettingsDocument) => boolean): boolean {
    const today = this.document;
    if (today !== null && test(today)) return true;
    for (const held of this.held.values()) if (held instanceof SettingsDocument && test(held)) return true;
    return false;
  }

  /** The header's change if it is held. The first sight of an id starts its
   * read in the background, unless too many are already running. */
  private headerDocument(candidate: string): SettingsDocument | null {
    if (this.refused) return null;
    const held = this.held.get(candidate);
    if (held !== undefined && !(typeof held === "number" && held <= Date.now())) {
      this.held.delete(candidate);
      this.held.set(candidate, held);
      return held instanceof SettingsDocument ? held : null;
    }
    if ([...this.held.values()].filter((v) => v === PENDING).length >= CANDIDATE_READS_AT_ONCE) return null;
    this.held.delete(candidate);
    this.held.set(candidate, PENDING);
    this.evict();
    void this.source.fetchCandidate(candidate, REQUEST_TIMEOUT_MS).then((read) => {
      if (!this.stopped) this.record(candidate, read);
    });
    return null;
  }

  private record(candidate: string, read: CandidateRead): void {
    if (read.outcome === "refused") {
      if (!this.refused) {
        warn("baton: this server's key is not a test key, so test changes are not fetched; today's settings apply.");
      }
      this.held.delete(candidate);
      this.refused = true;
    } else if (read.outcome === "failed") {
      this.held.set(candidate, Date.now() + this.retryAfterMs);
    } else {
      this.held.set(candidate, read.outcome === "loaded" ? read.document : null);
      this.evict();
    }
  }

  private evict(): void {
    // A read in flight is never dropped, so it cannot be started twice.
    for (const [key, value] of this.held) {
      if (this.held.size <= CANDIDATES_HELD) return;
      if (value !== PENDING) this.held.delete(key);
    }
  }
}

/** Whether some audience's overlay changes `piece` of Baton's text. */
export function overlayChanges(settings: CaptureSettings | undefined, piece: string): boolean {
  return settings?.someDocument((d) => d.audiencePieces.has(piece)) ?? false;
}

/** Whether some audience's overlay, today or in a held change, hides `name`. */
export function mayHide(settings: CaptureSettings | undefined, name: string): boolean {
  return settings?.someDocument((d) => d.hiddenSomewhere.has(name)) ?? false;
}
