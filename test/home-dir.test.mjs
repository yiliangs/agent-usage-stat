import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { homeDir, homeDirFrom } from "../dist/utils/paths.js";

/**
 * Home-directory precedence guard for issue #119.
 *
 * Four resolvers disagreed on Windows: paths.ts read $HOME first, the bin
 * bridge and the health check read $USERPROFILE first. On a machine where the
 * two diverge — enterprise roaming, a home drive, a customized Git Bash — the
 * desktop application and a hook-spawned helper then read different config
 * files, so captures land in one ledger and the dashboard reads another.
 *
 * The divergence needs Windows and a deliberately diverged $HOME to reproduce,
 * so the platform is a parameter here rather than the machine running the
 * suite.
 */

const DIVERGED = { HOME: "/git-bash/home", USERPROFILE: "C:\\Users\\real" };

test("Windows resolves the profile, matching the platform and os.homedir", () => {
  assert.equal(homeDirFrom(DIVERGED, "win32"), "C:\\Users\\real");
  // $HOME still answers when the profile is missing, so a stripped
  // environment keeps working rather than resolving to nothing.
  assert.equal(homeDirFrom({ HOME: "/git-bash/home" }, "win32"), "/git-bash/home");
});

test("elsewhere $HOME wins, since $USERPROFILE is the foreign variable", () => {
  assert.equal(homeDirFrom(DIVERGED, "darwin"), "/git-bash/home");
  assert.equal(homeDirFrom({ USERPROFILE: "C:\\Users\\real" }, "darwin"), "C:\\Users\\real");
});

test("an environment carrying neither variable resolves to nothing", () => {
  assert.equal(homeDirFrom({}, "win32"), "");
  assert.equal(homeDirFrom({}, "linux"), "");
  // homeDir reads this process, which always has one of the two.
  assert.ok(homeDir().length > 0);
});

test("no module re-derives the precedence for itself", () => {
  // The rule is the platform's, so a second spelling of it is how the two
  // views of the home directory come apart again.
  const pattern = /env\.(HOME|USERPROFILE)\s*\|\|\s*(process\.)?env\.(HOME|USERPROFILE)|environment\.(HOME|USERPROFILE)\s*\|\|\s*environment\.(HOME|USERPROFILE)/;
  const offenders = sourceFiles(join(process.cwd(), "src"))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => path.replace(process.cwd(), "").replace(/\\/g, "/"));

  assert.deepEqual(offenders, []);
});

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}
