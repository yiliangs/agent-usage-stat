import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { hookExecutablePaths } from "./hook-command.js";

/** Install an isolated user-level hook without rewriting Copilot settings. */
export async function installCopilotHook(hooksPath: string): Promise<void> {
  await mkdir(join(hooksPath, ".."), { recursive: true });
  const { unixWrapper, windowsBin, windowsUsesNode } = hookExecutablePaths();
  const args = "capture --detach --quiet";
  const config = {
    version: 1,
    hooks: {
      // PascalCase selects Copilot's VS Code-compatible snake_case payload.
      SessionEnd: [
        {
          type: "command",
          bash: `"${unixWrapper}" ${args}`,
          powershell: windowsUsesNode
            ? `node "${windowsBin}" ${args}`
            : `& "${windowsBin}" ${args}`,
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
