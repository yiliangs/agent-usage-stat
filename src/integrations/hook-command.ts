import { dirname, resolve } from "path";
import { homeDir } from "../utils/paths.js";

export interface HookExecutablePaths {
  unixWrapper: string;
  windowsBin: string;
  windowsUsesNode: boolean;
}

export interface CaptureHookCommands {
  unix: string;
  windows: string;
  powershell: string;
}

export interface CaptureHookInvocation {
  command: string;
  args: string[];
}

export function captureHookCommands(): CaptureHookCommands {
  const { unixWrapper, windowsBin, windowsUsesNode } = hookExecutablePaths();
  const args = "capture --detach --quiet";
  const windows = windowsUsesNode
    ? `node "${windowsBin}" ${args}`
    : `"${windowsBin}" ${args}`;
  return {
    unix: `"${unixWrapper}" ${args}`,
    windows,
    powershell: windowsUsesNode ? windows : `& ${windows}`,
  };
}

/**
 * The same capture invocation as an executable plus argument list, for hosts
 * whose hook is program code rather than a shell command line. Quoting rules
 * differ per shell and are a recurring source of broken hooks; a host that can
 * spawn a process directly should never have to re-parse a command string.
 */
export function captureHookInvocation(): CaptureHookInvocation {
  const { windowsBin, windowsUsesNode } = hookExecutablePaths();
  const args = ["capture", "--detach", "--quiet"];
  return windowsUsesNode
    ? { command: "node", args: [windowsBin, ...args] }
    : { command: windowsBin, args };
}

export function hookExecutablePaths(): HookExecutablePaths {
  if (process.env.AGENT_USAGE_STAT_STANDALONE === "1") {
    return {
      unixWrapper: process.execPath,
      windowsBin: process.execPath,
      windowsUsesNode: false,
    };
  }

  const packageRoot = resolve(dirname(process.argv[1] || process.cwd()), "..");
  const wrapperPath = resolve(packageRoot, "bin", "run-hook.sh");
  const binPath = resolve(packageRoot, "bin", "agent-usage-stat.js");
  const home = homeDir().replace(/\\/g, "/");
  const normalized = wrapperPath.replace(/\\/g, "/");
  const unixWrapper =
    home && normalized.toLowerCase().startsWith(home.toLowerCase())
      ? "$HOME" + normalized.slice(home.length)
      : normalized;
  return { unixWrapper, windowsBin: binPath, windowsUsesNode: true };
}

/** Recognize both the current package hook and hooks from its old name. */
export function isAgentUsageStatCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("agent-usage-stat") ||
    (normalized.includes("/bin/run-hook.sh") &&
      (normalized.includes(" capture") || normalized.includes(" generate")))
  );
}
