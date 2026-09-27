/**
 * Removing every integration this application installed, from inside it.
 *
 * Windows removes them from the Squirrel uninstall event, so an uninstall
 * through Settings never leaves a hook behind. macOS has no such event:
 * dragging the bundle to the Trash runs nothing, and the Claude, Codex,
 * Copilot, and opencode hooks, and any terminal wrappers an older command-line
 * install wrote, outlive the application. There the removal has to be a
 * command the user runs before discarding it.
 *
 * Electron-free by design, so the platform decision, the question, and the
 * report can be checked without a Mac to open the menu on.
 */

import type { SetupNotice, SetupQuestion } from "./setup-question.js";

/** The helper invocation that withdraws every hook and terminal wrapper. */
export const REMOVE_INTEGRATIONS_ARGS: readonly string[] = [
  "setup",
  "--uninstall",
];

export const REMOVE_INTEGRATIONS_LABEL = "Remove Agent Integrations...";

/**
 * Whether the application menu offers the removal.
 *
 * Only where no uninstaller runs it: on Windows the Squirrel uninstall event
 * already does, and a menu command there would only let a user who keeps the
 * application switch capture off behind the setup state's back.
 */
export const offersIntegrationRemoval = (platform: string): boolean =>
  platform === "darwin";

export type IntegrationRemovalChoice = "remove" | "cancel";

export function integrationRemovalPrompt(): SetupQuestion<IntegrationRemovalChoice> {
  return {
    message: "Remove every agent integration this application installed?",
    facts: [],
    detail: [
      "This removes the capture hooks from Claude Code, Codex, GitHub " +
      "Copilot CLI, and opencode, and any claude, codex, copilot, or claudex " +
      "terminal wrappers in your shell profile. Your usage history is kept.",
      "Run it before moving the application to the Trash. The application " +
      "quits afterwards; opening it again installs the integrations again.",
    ],
    options: [
      { value: "remove", label: "Remove" },
      { value: "cancel", label: "Cancel" },
    ],
  };
}

/** What the helper's exit says about the removal, as a notice to show. */
export function integrationRemovalNotice(result: {
  code: number;
  stdout: string;
  stderr: string;
}): SetupNotice {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
  if (result.code !== 0) {
    return {
      tone: "error",
      title: "Remove Agent Integrations",
      message: "The integrations could not be removed.",
      detail: output || `The helper exited with code ${result.code}.`,
    };
  }
  return {
    tone: "info",
    title: "Remove Agent Integrations",
    message: "Agent integrations removed.",
    detail: [
      output,
      "Agent Usage Stat will now quit. You can move it to the Trash.",
    ].filter(Boolean).join("\n\n"),
  };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
