import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import {
  captureHookCommands,
  isAgentUsageStatCommand,
} from "./hook-command.js";

interface CommandHook {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

interface CodexHooksFile {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** Install silent, detached Codex updates. Stop is per turn, not per task. */
export async function installCodexHooks(hooksPath: string): Promise<boolean> {
  await mkdir(join(hooksPath, ".."), { recursive: true });

  let config: CodexHooksFile = {};
  if (existsSync(hooksPath)) {
    const content = await readFile(hooksPath, "utf-8");
    await writeFile(`${hooksPath}.backup`, content, "utf-8");
    try {
      config = JSON.parse(content);
    } catch {
      throw new Error(
        "Failed to parse the existing Codex hooks file. Please check its format.",
      );
    }
  }

  config.hooks ||= {};
  const commands = captureHookCommands();
  const handler: CommandHook = {
    type: "command",
    command: commands.unix,
    commandWindows: commands.windows,
    timeout: 30,
    statusMessage: "Recording Codex usage",
  };
  const events = ["Stop", "SubagentStop"];
  const alreadyInstalled = events.every((event) => {
    const ours = (config.hooks?.[event] || []).flatMap((group) =>
      group.hooks.filter((hook) =>
        isAgentUsageStatCommand(`${hook.command} ${hook.commandWindows || ""}`),
      ),
    );
    return (
      ours.length === 1 &&
      ours[0].command === handler.command &&
      ours[0].commandWindows === handler.commandWindows
    );
  });

  for (const event of events) {
    config.hooks[event] = withoutAgentUsageStatHooks(config.hooks[event] || []);
    config.hooks[event].push({ hooks: [handler] });
  }

  await writeFile(hooksPath, JSON.stringify(config, null, 2), "utf-8");
  return !alreadyInstalled;
}

export async function removeCodexHooks(hooksPath: string): Promise<void> {
  if (!existsSync(hooksPath)) return;

  const content = await readFile(hooksPath, "utf-8");
  let config: CodexHooksFile;
  try {
    config = JSON.parse(content);
  } catch {
    throw new Error("Failed to parse the existing Codex hooks file.");
  }
  if (!config.hooks) return;

  for (const event of ["Stop", "SubagentStop"]) {
    const remaining = withoutAgentUsageStatHooks(config.hooks[event] || []);
    if (remaining.length > 0) config.hooks[event] = remaining;
    else delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;

  await writeFile(hooksPath, JSON.stringify(config, null, 2), "utf-8");
}

function withoutAgentUsageStatHooks(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((hook) => {
        const commands = `${hook.command} ${hook.commandWindows || ""}`;
        return !isAgentUsageStatCommand(commands);
      }),
    }))
    .filter((group) => group.hooks.length > 0);
}
