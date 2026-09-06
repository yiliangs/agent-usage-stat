import { installedHelperPath } from "../core/application-paths.js";

export interface CaptureHookCommands {
  unix: string;
  powershell: string;
}

export interface CaptureHookInvocation {
  command: string;
  args: string[];
}

const CAPTURE_ARGS = ["capture", "--detach", "--quiet"] as const;

/**
 * The executable every host hook names.
 *
 * The helper lives at one stable path, and a hook has to outlive whichever
 * copy of the application wrote it, so the path is derived from that location
 * rather than read off the running process. The two agree when the installed
 * helper is the one running, which is how a hook fires; they part company for
 * an application directory that a later version replaces, and for any other
 * process that configures hooks.
 */
export function hookExecutablePath(): string {
  return installedHelperPath();
}

export function captureHookCommands(): CaptureHookCommands {
  const command = `"${hookExecutablePath()}" ${CAPTURE_ARGS.join(" ")}`;
  return { unix: command, powershell: `& ${command}` };
}

/**
 * The same capture invocation as an executable plus argument list, for hosts
 * whose hook is program code rather than a shell command line. Quoting rules
 * differ per shell and are a recurring source of broken hooks; a host that can
 * spawn a process directly should never have to re-parse a command string.
 */
export function captureHookInvocation(): CaptureHookInvocation {
  return { command: hookExecutablePath(), args: [...CAPTURE_ARGS] };
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
