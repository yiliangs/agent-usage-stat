import { mkdir, readFile } from "fs/promises";
import { spawnSync } from "child_process";
import { basename, dirname, join } from "path";
import { backupOnce, writeFileAtomic } from "../utils/atomic-file.js";
import { homeDir, homeDirFrom } from "../utils/paths.js";
import { PROVIDER_NAMES } from "./provider-definition.js";

const BLOCK_START = "# >>> Agent Usage Stat terminal message >>>";
const BLOCK_END = "# <<< Agent Usage Stat terminal message <<<";
const BLOCK_PATTERN = new RegExp(
  `(?:\\r?\\n)?${escapeRegExp(BLOCK_START)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}(?:\\r?\\n)?`,
  "g",
);
// Windows PowerShell 5.1 decodes a mark-less profile as the system ANSI code
// page, so a helper path outside ASCII becomes mojibake and the wrapper
// function shadows the real CLI. pwsh reads the mark fine and the profile kind
// cannot tell the two hosts apart, so every PowerShell profile carries it.
const BOM = "\uFEFF";
const COMMANDS = [...PROVIDER_NAMES, "claudex"] as const;
export type WrappedCommand = (typeof COMMANDS)[number];

export type ShellProfileKind = "powershell" | "zsh" | "bash";

export interface ShellProfile {
  kind: ShellProfileKind;
  path: string;
}

export interface ProfileUpdate {
  profile: ShellProfile;
  changed: boolean;
}

export function detectShellProfile(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellProfile | null {
  const override = environment.AGENT_USAGE_STAT_SHELL_PROFILE;
  if (override) {
    const kind =
      platform === "win32"
        ? "powershell"
        : basename(environment.SHELL || "/bin/zsh") === "bash"
          ? "bash"
          : "zsh";
    return { kind, path: override };
  }
  if (platform === "win32") return detectPowerShellProfile(environment);
  if (platform !== "darwin") return null;

  const home = homeDirFrom(environment, platform) || homeDir();
  if (!home) return null;
  const shell = basename(environment.SHELL || "/bin/zsh");
  if (shell === "bash") return { kind: "bash", path: join(home, ".bash_profile") };
  return { kind: "zsh", path: join(home, ".zshrc") };
}

export async function installTerminalWrappers(
  profile: ShellProfile,
  cliPath: string,
  commands: readonly WrappedCommand[] = COMMANDS,
): Promise<ProfileUpdate> {
  const stored = await readOptional(profile.path);
  const marked = stored.startsWith(BOM);
  const existing = marked ? stored.slice(BOM.length) : stored;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const withoutBlock = existing.replace(BLOCK_PATTERN, "");
  const separator = withoutBlock && !withoutBlock.endsWith(eol) ? eol : "";
  const blankLine = withoutBlock.trim() ? eol : "";
  const block = renderBlock(profile.kind, cliPath, eol, commands);
  const body = `${withoutBlock}${separator}${blankLine}${block}${eol}`;
  // A PowerShell profile always gains the mark; every other kind keeps only the
  // one it already carried. Splicing the block on the unmarked text and adding
  // the mark back once is what keeps a second install a byte-for-byte no-op.
  const next = profile.kind === "powershell" || marked ? `${BOM}${body}` : body;

  if (next === stored) return { profile, changed: false };

  await mkdir(dirname(profile.path), { recursive: true });
  if (stored) await backupProfile(profile.path);
  await writeFileAtomic(profile.path, next);
  return { profile, changed: true };
}

export async function removeTerminalWrappers(
  profile: ShellProfile,
): Promise<ProfileUpdate> {
  const stored = await readOptional(profile.path);
  if (!stored.includes(BLOCK_START)) return { profile, changed: false };

  const marked = stored.startsWith(BOM);
  const existing = marked ? stored.slice(BOM.length) : stored;
  // Removal withdraws the block, not the file's encoding. What is left belongs
  // to the user, so keep the mark the file carries: adding one to a profile
  // without it would outlive the block, and stripping one this install may not
  // have written would break the user's own non-ASCII content.
  const body = existing.replace(BLOCK_PATTERN, "");
  const next = marked ? `${BOM}${body}` : body;
  await backupProfile(profile.path);
  await writeFileAtomic(profile.path, next);
  return { profile, changed: true };
}

export async function hasTerminalWrappers(
  profile: ShellProfile,
): Promise<boolean> {
  return (await readOptional(profile.path)).includes(BLOCK_START);
}

function detectPowerShellProfile(
  environment: NodeJS.ProcessEnv,
): ShellProfile | null {
  const shell = commandExists("pwsh", environment)
    ? "pwsh"
    : commandExists("powershell.exe", environment)
      ? "powershell.exe"
      : null;
  if (!shell) return null;

  const result = spawnSync(
    shell,
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "[Console]::Out.Write($PROFILE.CurrentUserAllHosts)",
    ],
    {
      encoding: "utf-8",
      env: environment,
      timeout: 3000,
      windowsHide: true,
    },
  );
  const path = result.status === 0 ? result.stdout.trim() : "";
  return path ? { kind: "powershell", path } : null;
}

function commandExists(
  command: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  const result = spawnSync("where.exe", [command], {
    env: environment,
    stdio: "ignore",
    timeout: 1500,
    windowsHide: true,
  });
  return result.status === 0;
}

function renderBlock(
  kind: ShellProfileKind,
  cliPath: string,
  eol: string,
  commands: readonly WrappedCommand[],
): string {
  const functions = commands.map((command) =>
    kind === "powershell"
      ? renderPowerShellFunction(command, cliPath, eol)
      : renderPosixFunction(command, cliPath, eol),
  ).join(eol + eol);
  return `${BLOCK_START}${eol}${functions}${eol}${BLOCK_END}`;
}

function renderPowerShellFunction(
  command: WrappedCommand,
  cliPath: string,
  eol: string,
): string {
  const quotedPath = cliPath.replace(/'/g, "''");
  const invocation = `& '${quotedPath}' run ${command} -- @args`;
  const lines = [
    `function global:${command} {`,
    `  ${invocation}`,
    "}",
  ];
  if (command !== "claudex") return lines.join(eol);

  return [
    "if (-not (Test-Path Function:\\claudex)) {",
    ...lines.map((line) => `  ${line}`),
    "}",
  ].join(eol);
}

function renderPosixFunction(
  command: WrappedCommand,
  cliPath: string,
  eol: string,
): string {
  const quotedPath = cliPath.replace(/'/g, `'"'"'`);
  const invocation = `'${quotedPath}' run ${command} -- "$@"`;
  const lines = [
    `${command}() {`,
    `  ${invocation}`,
    "}",
  ];
  if (command !== "claudex") return lines.join(eol);

  return [
    "if ! typeset -f claudex >/dev/null 2>&1; then",
    ...lines.map((line) => `  ${line}`),
    "fi",
  ].join(eol);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** The profile as it was before we first touched it. A later idempotent
 *  marker update must not replace that record with our own block. */
const backupProfile = (path: string): Promise<void> =>
  backupOnce(path, `${path}.agent-usage-stat.backup`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
