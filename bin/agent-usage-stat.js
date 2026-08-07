#!/usr/bin/env node

// Compatibility bridge for terminal sessions opened before the desktop migration.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.USERPROFILE || process.env.HOME;
const executable = process.platform === "win32"
  ? "agent-usage-stat-helper.exe"
  : "agent-usage-stat-helper";
const helper = home
  ? join(home, ".agent-usage-stat", "bin", executable)
  : "";

if (!helper || !existsSync(helper)) {
  process.stderr.write(
    "Agent Usage Stat desktop helper is not installed. Restart the app to repair agent connections.\n",
  );
  process.exit(1);
}

const result = spawnSync(helper, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
