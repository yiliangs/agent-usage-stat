import { join } from "node:path";
import { homeDir } from "../utils/paths.js";

const APPLICATION_DIR_NAME = ".agent-usage-stat";

export function applicationStateDir(): string {
  return join(homeDir(), APPLICATION_DIR_NAME);
}

export function installedHelperPath(
  platform: NodeJS.Platform = process.platform,
): string {
  const name = platform === "win32"
    ? "agent-usage-stat-helper.exe"
    : "agent-usage-stat-helper";
  return join(applicationStateDir(), "bin", name);
}

export function desktopSetupStatePath(): string {
  return join(applicationStateDir(), "desktop-setup.json");
}

export function installedHelperStatePath(): string {
  return join(applicationStateDir(), "bin", "helper-version.json");
}
