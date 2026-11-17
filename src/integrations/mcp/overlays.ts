/** Overlays in the settings document (SPEC §2.6): read, place, and change text.
 * The TypeScript half of Python's `_overlays.py`. */

import { isRecord } from "../../_object.js";
import { stripWhiteSpaceEnd } from "../../_text.js";
import { warn } from "../../warn.js";

export type Place = "audience" | "server";

export const INSTRUCTION_PIECES: readonly string[] = ["instructions.subagent", "instructions.report_pointer"];
const AUDIENCE_PIECES: readonly string[] = ["goal_param.description", "report_tool.description", "report_tool.refusal"];
const TEXT_CHANGES: readonly string[] = ["append", "replace"];
const FLAG_CHANGES: readonly string[] = ["remove", "required"];

// Overlay ids never change once saved, so one warning per action is enough.
const warned = new Set<string>();
const unreadable = new Set<string>();

export function warnSkipped(overlayId: string, index: number, reason: string): void {
  const key = JSON.stringify([overlayId, index]);
  if (warned.has(key)) return;
  warned.add(key);
  warn(`baton: overlay ${JSON.stringify(overlayId)} action ${index} is skipped: ${reason}`);
}

export interface Action {
  readonly index: number;
  readonly change: string;
  readonly text?: string;
  readonly tool?: string;
  readonly param?: string;
  readonly piece?: string;
  readonly instructions?: true;
}

export class Overlay {
  readonly hiddenTools: ReadonlySet<string>;

  constructor(
    readonly id: string,
    readonly actions: readonly Action[],
  ) {
    this.hiddenTools = new Set(
      actions.filter((a) => a.tool !== undefined && a.param === undefined && a.change === "remove").map((a) => a.tool!),
    );
  }

  pieceActions(piece: string): readonly Action[] {
    return this.actions.filter((a) => a.piece === piece);
  }

  instructionAppends(): string[] {
    return this.actions.filter((a) => a.instructions && a.text !== undefined).map((a) => a.text!);
  }
}

export type TextSource = "default" | "appended" | "replaced";

/** `text` after `actions`, and its `agent_text` source. */
export function changedText(
  text: string | undefined,
  actions: readonly Action[],
): { text: string | undefined; source: TextSource } {
  let source: TextSource = "default";
  for (const action of actions) {
    if (action.change === "replace") {
      text = action.text;
      source = "replaced";
    } else if (action.change === "append" && action.text !== undefined) {
      const kept = stripWhiteSpaceEnd(text ?? "");
      text = kept ? `${kept}\n\n${action.text}` : action.text;
      if (source === "default") source = "appended";
    }
  }
  return { text, source };
}

/** `text`, the piece `piece` of Baton's text, after `overlay`. */
export function overlaid(text: string, overlay: Overlay | undefined, piece: string): string {
  if (overlay === undefined) return text;
  return changedText(text, overlay.pieceActions(piece)).text ?? text;
}

/** The document's `overlays`; one that is not an object holds none. */
export function readOverlays(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The overlay `overlayId` names, holding the actions allowed in `place`.
 * `undefined` with one warning when it cannot be read; a bad action is skipped alone. */
export function overlayFor(overlays: Record<string, unknown>, overlayId: unknown, place: Place): Overlay | undefined {
  if (overlayId === undefined || overlayId === null) return undefined;
  let id: string;
  let body: unknown;
  if (typeof overlayId === "string") {
    id = overlayId;
    body = Object.hasOwn(overlays, id) ? overlays[id] : undefined;
  } else {
    id = JSON.stringify(overlayId);
  }
  const actions = isRecord(body) ? body.actions : undefined;
  if (!Array.isArray(actions)) {
    if (!unreadable.has(id)) {
      unreadable.add(id);
      warn(`baton: overlay ${JSON.stringify(id)} cannot be read; none is applied there`);
    }
    return undefined;
  }
  const kept: Action[] = [];
  actions.forEach((raw, index) => {
    const read = readAction(index, raw, place);
    if (typeof read === "string") warnSkipped(id, index, read);
    else kept.push(read);
  });
  return new Overlay(id, kept);
}

/** The action, or why it is skipped. */
function readAction(index: number, raw: unknown, place: Place): Action | string {
  if (!isRecord(raw) || !isRecord(raw.target)) return "it has no target";
  const target = raw.target;
  const changes = [...TEXT_CHANGES, ...FLAG_CHANGES].filter((c) => Object.hasOwn(raw, c));
  if (changes.length !== 1 || Object.keys(raw).length !== 2) return "it needs exactly one change";
  const change = changes[0]!;
  const value = raw[change];
  if (TEXT_CHANGES.includes(change) && typeof value !== "string") return `'${change}' needs text`;
  if (FLAG_CHANGES.includes(change) && value !== true) return `'${change}' must be true`;
  const text = typeof value === "string" ? { text: value } : {};
  const keys = Object.keys(target).sort().join(",");
  if (keys === "tool" && typeof target.tool === "string") {
    if (change === "required") return "only a param can be required";
    return placed({ index, change, ...text, tool: target.tool }, place, "audience");
  }
  if (keys === "param,tool" && typeof target.tool === "string" && typeof target.param === "string") {
    return placed({ index, change, ...text, tool: target.tool, param: target.param }, place, "audience");
  }
  if (keys === "instructions" && target.instructions === true) {
    if (change !== "append") return "the instructions take only 'append'";
    return placed({ index, change, ...text, instructions: true }, place, "server");
  }
  if (keys === "agent_text" && typeof target.agent_text === "string") {
    const piece = target.agent_text;
    if (!TEXT_CHANGES.includes(change)) return "agent_text takes only 'append' or 'replace'";
    if (INSTRUCTION_PIECES.includes(piece)) return placed({ index, change, ...text, piece }, place, "server");
    if (AUDIENCE_PIECES.includes(piece)) return placed({ index, change, ...text, piece }, place, "audience");
    return `unknown agent_text ${JSON.stringify(piece)}`;
  }
  return "unknown target";
}

function placed(action: Action, place: Place, allowed: Place): Action | string {
  if (place === allowed) return action;
  return `this target goes only in ${allowed === "server" ? "server_overlay" : "an audience's overlay"}`;
}
