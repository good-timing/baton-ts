import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

/** The `extra` argument every `McpServer` tool callback receives, whether
 * registered via `registerTool` or the annotation tool. */
export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
