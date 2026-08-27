import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homeDir } from "./paths.js";

/**
 * Append a one-line event to ~/.agent-usage-stat/hook.log. Fails silently so
 * logging never breaks the hook. The log is the only window into hook
 * behavior because detached hooks have no console.
 *
 * Lives in its own module (Node built-ins only) so the detach shim can import
 * it without dragging in provider parsers or worker code. See detach-shim.ts.
 */
export function logHookEvent(message: string): void {
  try {
    const home = homeDir();
    if (!home) return;
    const dir = join(home, ".agent-usage-stat");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();
    appendFileSync(join(dir, "hook.log"), `[${stamp}] ${message}\n`, "utf-8");
  } catch {
    // log failures are not worth crashing the hook for
  }
}
