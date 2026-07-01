import { createChatToolSet } from "./registry";
import type { ToolScope } from "./registry";

export function isChatToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_TOOLS === "true";
}

export function createChatToolsForScope(scope: ToolScope, env: NodeJS.ProcessEnv = process.env) {
  if (!isChatToolsEnabled(env)) {
    return undefined;
  }
  return createChatToolSet(scope);
}
