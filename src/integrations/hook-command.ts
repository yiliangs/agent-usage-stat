import { installedHelperPath } from "../core/application-paths.js";
import type { ProviderName } from "../core/provider-definition.js";

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
 * The capture arguments for one host's hook. Hook event names overlap across
 * hosts and a payload that fails to parse carries none, so the hook names its
 * host outright: that host owns the capture-health record of every attempt
 * the hook makes, including one that fails before any provider is resolved.
 */
function captureArgs(host: ProviderName): string[] {
  return [...CAPTURE_ARGS, "--host", host];
}

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

export function captureHookCommands(host: ProviderName): CaptureHookCommands {
  const command = `"${hookExecutablePath()}" ${captureArgs(host).join(" ")}`;
  return { unix: command, powershell: `& ${command}` };
}

/**
 * The same capture invocation as an executable plus argument list, for hosts
 * whose hook is program code rather than a shell command line. Quoting rules
 * differ per shell and are a recurring source of broken hooks; a host that can
 * spawn a process directly should never have to re-parse a command string.
 */
export function captureHookInvocation(host: ProviderName): CaptureHookInvocation {
  return { command: hookExecutablePath(), args: captureArgs(host) };
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
