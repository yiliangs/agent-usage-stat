import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import chalk from "chalk";
import {
  captureHookCommands,
  isAgentUsageStatCommand,
} from "./hook-command.js";

interface ClaudeSettings {
  hooks?: {
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
  settings.hooks.SessionEnd ||= [];

  const hookCommand = captureHookCommands().unix;
  const existingHook = settings.hooks.SessionEnd.find((group) =>
    group.hooks.some((hook) => isAgentUsageStatCommand(hook.command)),
  );

  if (existingHook) {
    if (existingHook.hooks.some((hook) => hook.command === hookCommand)) return;
    console.log(chalk.yellow("\nClaude Code hook already installed; updating it."));
    settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
      (group) =>
        !group.hooks.some((hook) => isAgentUsageStatCommand(hook.command)),
    );
  }

  settings.hooks.SessionEnd.push({
    hooks: [{ type: "command", command: hookCommand }],
  });
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

  if (!settings.hooks?.SessionEnd) return;
  settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
    (group) =>
      !group.hooks.some((hook) => isAgentUsageStatCommand(hook.command)),
  );
  if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}
