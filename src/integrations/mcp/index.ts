export { createBaton, withBaton } from "./withBaton.js";
export type { Baton, SupportedMcpServer } from "./withBaton.js";
export { BatonHandle } from "./handle.js";
export type { BatonConfig } from "./config.js";
export type { ResultCaptureMode } from "./errorResult.js";
export type { ResolvePrincipalHook, PrincipalResolutionContext } from "./principalResolution.js";
export type { AuthInfo } from "./mcpTypes.js";
export { principalFromOAuthEmail, principalFromOAuthSub } from "./oauthHooks.js";
