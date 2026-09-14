/**
 * The annotation tool's name and the vendor's display name, both resolved
 * from the server object `withBaton` is handed.
 *
 * `withBaton(server, { dsn })` receives the vendor's `McpServer`, and that
 * object knows its own name. Without it, both defaults come from the DSN's
 * server segment, an opaque `srv-<8 hex>` the console mints: a stranger's walk
 * of the self-serve lane on 2026-09-14 saw a tool called
 * `srv-c8eca135_annotate`, and instructions calling the vendor `srv-c8eca135`,
 * on a server its author had named `toybox-pantry`.
 *
 * The tool-name half is a port of `baton` (Python)'s
 * `integrations/_annotation_name.py` as released in 0.8.3. The display-name
 * half is new in both SDKs together, so the two implement ONE rule. Kept in
 * step by hand.
 *
 * **Cosmetic local labels, never ids.** `vendorId` and `tenantId` stay opaque
 * and console-owned. The tool name does reach the wire in one place,
 * `surface_snapshot.seam_augmentations.injected_tools`, so a consumer matches
 * that list by the `_annotate` suffix, never by an exact name.
 *
 * **Order, and why the display name goes first.** Both names enter the server
 * instructions, whose cap THROWS, so they share one budget. The display name
 * is resolved first, checked beside the tool name the install would otherwise
 * use (the explicit one, or `{vendorId}_annotate`); the tool name is then
 * checked beside the display name that won. Each step keeps a name only if it
 * renders beside the other, so neither can turn a server that booted before
 * this rule into one that throws, and where both derived names do not fit
 * together it is the tool name that gives way. The second check is Python
 * 0.8.3's own (`annotation_tool_name_from_server` already measures against the
 * resolved display name), so this order leaves that code as it is.
 *
 * ⚠ **Nothing here throws, except on a tool name the vendor passed
 * explicitly.** Both labels are cosmetic and a vendor's boot is not, so every
 * path that cannot produce a name returns `undefined` and the caller falls
 * back.
 */

import { pythonStrip } from "../../identity.js";
import { fitsInstructionsCap } from "./llmText.js";

/** The strictest known client pattern (Claude Desktop): dots, slashes and
 * other separators are rejected. One copy, for the explicit name and the
 * derived one alike. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const SUFFIX = "_annotate";

/** Cap on the SLUG, and the binding constraint is not the pattern's 64: the
 * tool name shares the instructions budget with the display name, so a longer
 * one buys a shorter legal display name. Python's number, kept identical. The
 * cap is not the safety property; `fitsInstructionsCap` is. */
export const SLUG_CAP = 30;

/** What a library calls a server nobody named. These two are Python's: its
 * official SDK defaults to `"FastMCP"` on mcp 1.x and `"mcp-server"` on 2.x.
 *
 * Neither TypeScript peer adds one. Both `McpServer` constructors store the
 * `serverInfo` they are handed with no default, and both type it as a
 * required `Implementation` (measured on `@modelcontextprotocol/sdk` 1.30.0
 * and `@modelcontextprotocol/server` 2.0.0). The Python strings stay here
 * anyway: this is one rule across both SDKs, and a TypeScript server called
 * `FastMCP` carries a name copied from somewhere, not one its vendor chose. */
const PLACEHOLDER_LITERALS = new Set(["fastmcp", "mcp-server"]);

/** fastmcp's default is `${ClassName}-${4 hex}`, minted per construction, so a
 * name derived from it would change on every restart. Matched against the
 * server's OWN class name rather than a bare trailing `-[0-9a-f]{4}`, because
 * hex spells words: `toybox-cafe` is a real name. */
const RANDOM_SUFFIX = /-[0-9a-f]{4}$/;

function isLibraryPlaceholder(serverName: string, className: string): boolean {
  const stripped = pythonStrip(serverName);
  if (PLACEHOLDER_LITERALS.has(stripped.toLowerCase())) return true;
  const stem = stripped.replace(RANDOM_SUFFIX, "");
  return stem !== stripped && stem === className;
}

/** `process.emitWarning`, guarded like every `process` read in this package:
 * `console` is banned (stdout is the MCP JSON-RPC frame under stdio), and edge
 * runtimes have no `process` at all. */
function warn(message: string): void {
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(message);
  }
}

/**
 * The name the vendor gave their server, or `undefined` when there is none to
 * use: a read that throws, a value that is not a string, a blank one, or a
 * name a library made up.
 *
 * Takes a reader rather than the server, so the private-field access stays in
 * `withBaton.ts` on its named internals shape, beside the other reach-ins. The
 * reader runs inside the guard because it touches the vendor's object.
 *
 * Blank is refused although Python's rule does not name it: `validateBatonConfig`
 * refuses a blank display name, and a cosmetic default may not be the thing
 * that stops a server from starting.
 */
export function usableServerName(
  read: () => { name: unknown; className: unknown },
): string | undefined {
  let name: unknown;
  let className: unknown;
  try {
    ({ name, className } = read());
  } catch {
    warn(
      "baton: reading the server name failed; using the DSN's server segment " +
        "and {vendorId}_annotate instead.",
    );
    return undefined;
  }
  if (typeof name !== "string" || pythonStrip(name) === "") return undefined;
  if (isLibraryPlaceholder(name, typeof className === "string" ? className : "")) {
    return undefined;
  }
  return name;
}

/** Slug a server name for use as a tool-name stem, or `undefined` if nothing
 * is left. Python's transform exactly: strip, lowercase, every character
 * outside `[a-z0-9-]` to a hyphen, collapse, strip hyphens, cap. */
export function slugServerName(serverName: string): string | undefined {
  const mapped = pythonStrip(serverName).toLowerCase().replace(/[^a-z0-9-]/gu, "-");
  const collapsed = mapped.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  // Cut BEFORE the final strip: slicing can leave a trailing hyphen, which
  // reads as a truncation artefact.
  return collapsed.slice(0, SLUG_CAP).replace(/^-+|-+$/g, "") || undefined;
}

/**
 * The display name from the server's own name, VERBATIM, or `undefined`.
 *
 * Not slugged: it is a string the vendor chose, and it reaches their users.
 * Rendered beside the tool name this install would use if nothing were
 * derived, so a name that does not fit leaves the DSN segment in place rather
 * than making the install throw.
 */
export function displayNameFromServer(
  serverName: string | undefined,
  tool: { vendorId: string; annotationToolName?: string | undefined },
): string | undefined {
  if (serverName === undefined) return undefined;
  const fallbackToolName = tool.annotationToolName || `${tool.vendorId}${SUFFIX}`;
  if (!fitsInstructionsCap({ vendorDisplayName: serverName, annotationToolName: fallbackToolName })) {
    warn(
      `baton: the server name (${serverName.length} chars) does not fit the ` +
        "server-instructions budget as the display name; keeping the DSN's " +
        "server segment. Pass vendorDisplayName to choose a shorter one.",
    );
    return undefined;
  }
  return serverName;
}

/**
 * A readable `{slug}_annotate` from the server's own name, or `undefined`.
 *
 * Returns only a name it has already checked against the pattern, so the
 * caller can pass it straight in as an override without that becoming a
 * second throw site. Rendered beside the display name that won, and never
 * worse than the fallback: a name that does not fit is discarded and
 * `{vendorId}_annotate` stays.
 */
export function annotationToolNameFromServer(
  serverName: string | undefined,
  vendorDisplayName: string,
): string | undefined {
  if (serverName === undefined) return undefined;
  const slug = slugServerName(serverName);
  if (slug === undefined) return undefined;
  const candidate = `${slug}${SUFFIX}`;
  // The slug's alphabet is a subset of the pattern's and the cap is well
  // inside it, so this cannot currently fail. Checked anyway, because the
  // alternative to a check here is a throw at a vendor's startup.
  if (!TOOL_NAME_PATTERN.test(candidate)) return undefined;
  if (!fitsInstructionsCap({ vendorDisplayName, annotationToolName: candidate })) {
    warn(
      `baton: the server-derived annotation tool name ${JSON.stringify(candidate)} ` +
        "does not fit the server-instructions budget beside the display name " +
        `(${vendorDisplayName.length} chars); keeping {vendorId}_annotate. ` +
        "A shorter display name gets the readable one.",
    );
    return undefined;
  }
  return candidate;
}

/** Compose and VALIDATE the final tool name: the last step of the ladder, and
 * its one throw site. Reached with a vendor's explicit name or an
 * already-validated derived one, never with a guess. */
export function deriveAnnotationToolName(vendorId: string, override?: string): string {
  const name = override || `${vendorId}${SUFFIX}`;
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Annotation tool name ${JSON.stringify(name)} violates the cross-runtime ` +
        `pattern ${TOOL_NAME_PATTERN.source} (Claude Desktop and others reject ` +
        "names with dots or other separators).",
    );
  }
  return name;
}

/** The whole tool-name ladder in one call: explicit, then derived from the
 * server's name, then `{vendorId}_annotate`. Python's
 * `resolve_annotation_tool_name`. */
export function resolveAnnotationToolName(
  serverName: string | undefined,
  config: { vendorId: string; vendorDisplayName: string; annotationToolName?: string | undefined },
): string {
  return deriveAnnotationToolName(
    config.vendorId,
    config.annotationToolName ||
      annotationToolNameFromServer(serverName, config.vendorDisplayName),
  );
}
