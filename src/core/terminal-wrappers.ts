import { constants } from "fs";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { spawnSync } from "child_process";
import { basename, dirname, join } from "path";
import { homeDir, homeDirFrom } from "../utils/paths.js";
import { PROVIDER_NAMES } from "./provider-definition.js";

const BLOCK_START = "# >>> Agent Usage Stat terminal message >>>";
const BLOCK_END = "# <<< Agent Usage Stat terminal message <<<";
const BLOCK_PATTERN = new RegExp(
  `(?:\\r?\\n)?${escapeRegExp(BLOCK_START)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}(?:\\r?\\n)?`,
  "g",
);
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
  usesNode = true,
  commands: readonly WrappedCommand[] = COMMANDS,
): Promise<ProfileUpdate> {
  const existing = await readOptional(profile.path);
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const withoutBlock = existing.replace(BLOCK_PATTERN, "");
  const separator = withoutBlock && !withoutBlock.endsWith(eol) ? eol : "";
  const blankLine = withoutBlock.trim() ? eol : "";
  const block = renderBlock(profile.kind, cliPath, usesNode, eol, commands);
  const next = `${withoutBlock}${separator}${blankLine}${block}${eol}`;

  if (next === existing) return { profile, changed: false };

  await mkdir(dirname(profile.path), { recursive: true });
  if (existing) await createBackup(profile.path);
  await writeFile(profile.path, next, "utf-8");
  return { profile, changed: true };
}

export async function removeTerminalWrappers(
  profile: ShellProfile,
): Promise<ProfileUpdate> {
  const existing = await readOptional(profile.path);
  if (!existing.includes(BLOCK_START)) return { profile, changed: false };

  const next = existing.replace(BLOCK_PATTERN, "");
  await createBackup(profile.path);
  await writeFile(profile.path, next, "utf-8");
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
  usesNode: boolean,
  eol: string,
  commands: readonly WrappedCommand[],
): string {
  const functions = commands.map((command) =>
    kind === "powershell"
      ? renderPowerShellFunction(command, cliPath, usesNode, eol)
      : renderPosixFunction(command, cliPath, usesNode, eol),
  ).join(eol + eol);
  return `${BLOCK_START}${eol}${functions}${eol}${BLOCK_END}`;
}

function renderPowerShellFunction(
  command: WrappedCommand,
  cliPath: string,
  usesNode: boolean,
  eol: string,
): string {
  const quotedPath = cliPath.replace(/'/g, "''");
  const invocation = usesNode
    ? `& node '${quotedPath}' run ${command} -- @args`
    : `& '${quotedPath}' run ${command} -- @args`;
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
  usesNode: boolean,
  eol: string,
): string {
  const quotedPath = cliPath.replace(/'/g, `'"'"'`);
  const invocation = usesNode
    ? `node '${quotedPath}' run ${command} -- "$@"`
    : `'${quotedPath}' run ${command} -- "$@"`;
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

async function createBackup(path: string): Promise<void> {
  try {
    await copyFile(path, `${path}.agent-usage-stat.backup`, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      // A missing profile has nothing to back up. Other backup failures should
      // not block an idempotent marker update.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
