import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  captureHookCommands,
  isAgentUsageStatCommand,
} from "./hook-command.js";
import type { HookConfigurationStatus } from "./hook-status.js";

export async function inspectCopilotHook(
  hooksPath: string,
): Promise<HookConfigurationStatus> {
  if (!existsSync(hooksPath)) return "missing";
  try {
    const config = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks?: Record<string, Array<{
        bash?: string;
        powershell?: string;
      }>>;
    };
    const installed = (config.hooks?.SessionEnd || []).some((hook) =>
      isAgentUsageStatCommand(`${hook.bash || ""} ${hook.powershell || ""}`)
    );
    return installed ? "configured" : "missing";
  } catch {
    return "invalid";
  }
}

/** Install an isolated user-level hook without rewriting Copilot settings. */
export async function installCopilotHook(hooksPath: string): Promise<void> {
  await mkdir(join(hooksPath, ".."), { recursive: true });
  const commands = captureHookCommands();
  const config = {
    version: 1,
    hooks: {
      // PascalCase selects Copilot's VS Code-compatible snake_case payload.
      SessionEnd: [
        {
          type: "command",
          bash: commands.unix,
          powershell: commands.powershell,
          timeoutSec: 30,
        },
      ],
    },
  };
  await writeFile(hooksPath, JSON.stringify(config, null, 2), "utf-8");
}

export async function removeCopilotHook(hooksPath: string): Promise<void> {
  await rm(hooksPath, { force: true });
}
