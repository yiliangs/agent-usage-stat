#!/usr/bin/env node

// Compatibility bridge for terminal sessions opened before the desktop migration.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The one home-directory rule this file cannot import: the bridge has to
// locate the installed helper without a build present, so it repeats the
// precedence src/utils/paths.ts owns instead of loading it from dist/. Keep
// the two in step — the profile first, because Windows is where they diverge.
const home = process.platform === "win32"
  ? process.env.USERPROFILE || process.env.HOME
  : process.env.HOME || process.env.USERPROFILE;
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
