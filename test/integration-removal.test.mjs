import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { applicationMenuTemplate } from "../dist/desktop/application-menu.js";
import {
  REMOVE_INTEGRATIONS_ARGS,
  REMOVE_INTEGRATIONS_LABEL,
  integrationRemovalNotice,
  integrationRemovalPrompt,
  offersIntegrationRemoval,
} from "../dist/desktop/integration-removal.js";
import { setupAnswerAt } from "../dist/desktop/setup-question.js";

/**
 * The in-app removal of every integration, for issue #115.
 *
 * macOS runs nothing when the bundle goes to the Trash, so the hooks outlive
 * the application unless the menu offers their removal first. Windows already
 * removes them from the Squirrel uninstall event and must not grow a second
 * path.
 */

function menuActions() {
  const calls = [];
  return {
    calls,
    actions: {
      refresh: () => calls.push("refresh"),
      openSettings: () => calls.push("settings"),
      removeIntegrations: () => calls.push("remove"),
    },
  };
}

function applicationSubmenu(platform) {
  const { calls, actions } = menuActions();
  const [first] = applicationMenuTemplate(platform, "Agent Usage Stat", actions);
  return { calls, items: first.submenu };
}

test("only macOS offers the removal, since only it has no uninstaller to run it", () => {
  assert.equal(offersIntegrationRemoval("darwin"), true);
  assert.equal(offersIntegrationRemoval("win32"), false);
  assert.equal(offersIntegrationRemoval("linux"), false);
});

test("the macOS application menu carries the removal command, and it runs the removal", () => {
  const { calls, items } = applicationSubmenu("darwin");
  const removal = items.find((item) => item.label === REMOVE_INTEGRATIONS_LABEL);
  assert.ok(removal, "the removal command is missing from the macOS menu");

  removal.click();
  assert.deepEqual(calls, ["remove"]);

  // It sits with the application's own commands, before Hide and Quit.
  const at = items.indexOf(removal);
  assert.ok(at > items.findIndex((item) => item.label === "Settings..."));
  assert.ok(at < items.findIndex((item) => item.role === "hide"));
});

test("the Windows menu has no removal command, which the Squirrel uninstall owns", () => {
  const { items } = applicationSubmenu("win32");
  assert.equal(
    items.some((item) => item.label === REMOVE_INTEGRATIONS_LABEL),
    false,
  );
  assert.deepEqual(
    items.map((item) => item.label ?? item.role ?? item.type),
    ["Refresh Data", "separator", "Settings...", "separator", "quit"],
  );
});

test("the removal runs the helper's own uninstall, the same one Squirrel runs", async () => {
  assert.deepEqual(REMOVE_INTEGRATIONS_ARGS, ["setup", "--uninstall"]);
  const main = await readFile(join(process.cwd(), "src", "desktop", "main.ts"), "utf8");
  const squirrel = main.slice(main.indexOf("async function performSquirrelEvent"));
  assert.match(
    squirrel,
    /--squirrel-uninstall"[\s\S]*?spawnAndWait\(helper, \[\.\.\.REMOVE_INTEGRATIONS_ARGS\]\)/,
  );
});

test("only the Remove answer removes", () => {
  const question = integrationRemovalPrompt();
  assert.deepEqual(question.options.map((option) => option.value), ["remove", "cancel"]);
  assert.equal(setupAnswerAt(question, 0, false)?.value, "remove");
  assert.equal(setupAnswerAt(question, 1, false)?.value, "cancel");
  assert.match(question.detail.join(" "), /usage history is kept/);
});

test("a clean helper exit reports removal and the quit that follows", () => {
  const notice = integrationRemovalNotice({
    code: 0,
    stdout: "\u001b[32mAgent hooks removed\u001b[39m\n",
    stderr: "",
  });
  assert.equal(notice.tone, "info");
  assert.match(notice.detail, /^Agent hooks removed/);
  assert.doesNotMatch(notice.detail, /\u001b/);
  assert.match(notice.detail, /will now quit/);
});

test("a failed helper exit reports the failure with what the helper said", () => {
  const notice = integrationRemovalNotice({
    code: 1,
    stdout: "",
    stderr: "Error: permission denied",
  });
  assert.equal(notice.tone, "error");
  assert.equal(notice.detail, "Error: permission denied");
  assert.equal(
    integrationRemovalNotice({ code: 2, stdout: "", stderr: "" }).detail,
    "The helper exited with code 2.",
  );
});
