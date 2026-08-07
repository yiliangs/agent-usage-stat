import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { captureHookCommands } from "./hook-command.js";

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
