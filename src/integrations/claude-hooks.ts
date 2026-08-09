import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import chalk from "chalk";
import {
  captureHookCommands,
  isAgentUsageStatCommand,
} from "./hook-command.js";
import type { HookConfigurationStatus } from "./hook-status.js";

interface ClaudeSettings {
  disableAllHooks?: boolean;
  hooks?: {
    Stop?: ClaudeHookGroup[];
    SessionEnd?: Array<{
      hooks: Array<{
        type: string;
        command: string;
      }>;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ClaudeHookGroup {
  hooks: Array<{
    type: string;
    command: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

const CAPTURE_EVENTS = ["Stop", "SessionEnd"] as const;

export async function inspectClaudeHook(
  settingsPath: string,
): Promise<HookConfigurationStatus> {
  if (!existsSync(settingsPath)) return "missing";
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as ClaudeSettings;
    if (settings.disableAllHooks === true) return "disabled";
    return CAPTURE_EVENTS.every((event) =>
        ((settings.hooks?.[event] ?? []) as ClaudeHookGroup[]).some((group) =>
          group.hooks?.some((hook) => isAgentUsageStatCommand(hook.command))
        )
      )
      ? "configured"
      : "missing";
  } catch {
    return "invalid";
  }
}

export async function installClaudeHook(settingsPath: string): Promise<void> {
  const claudeDir = join(settingsPath, "..");
  await mkdir(claudeDir, { recursive: true });

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    const content = await readFile(settingsPath, "utf-8");
    await writeFile(`${settingsPath}.backup`, content, "utf-8");
    try {
      settings = JSON.parse(content);
    } catch {
      throw new Error(
        "Failed to parse existing settings.json. Please check the file format.",
      );
    }
  }

  settings.hooks ||= {};
  const hookCommand = captureHookCommands().unix;
  let updating = false;
  for (const event of CAPTURE_EVENTS) {
    const groups = (settings.hooks[event] ?? []) as ClaudeHookGroup[];
    if (groups.some((group) =>
      group.hooks.some((hook) => isAgentUsageStatCommand(hook.command))
    )) updating = true;
    settings.hooks[event] = withoutAgentUsageStatHooks(groups);
    settings.hooks[event]!.push({
      hooks: [{ type: "command", command: hookCommand }],
    });
  }
  if (updating) {
    console.log(chalk.yellow("\nClaude Code hooks already installed; updating them."));
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

export async function removeClaudeHook(settingsPath: string): Promise<void> {
  if (!existsSync(settingsPath)) return;

  const content = await readFile(settingsPath, "utf-8");
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(content);
  } catch {
    throw new Error("Failed to parse settings.json");
  }

  if (!settings.hooks) return;
  for (const event of CAPTURE_EVENTS) {
    const groups = (settings.hooks[event] ?? []) as ClaudeHookGroup[];
    const remaining = withoutAgentUsageStatHooks(groups);
    if (remaining.length > 0) settings.hooks[event] = remaining;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

function withoutAgentUsageStatHooks(groups: ClaudeHookGroup[]): ClaudeHookGroup[] {
  return groups
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((hook) => !isAgentUsageStatCommand(hook.command)),
    }))
    .filter((group) => group.hooks.length > 0);
}
