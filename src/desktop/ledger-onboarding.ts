import type { ResolvedUsageRoot } from "../utils/usage-root.js";

export interface LedgerLocationPrompt {
  message: string;
  detail: string;
  buttons: [string, string];
}

export interface LedgerMigrationPrompt {
  message: string;
  detail: string;
  buttons: [string, string];
  checkboxLabel: string;
  checkboxChecked: boolean;
}

const SHARED_LEDGER_NOTE =
  "Using multiple computers? Choose a folder in Google Drive, OneDrive, " +
  "Dropbox, or another synchronized drive, then select that same synchronized " +
  "folder on each computer. Paths may differ by machine.";

const LEDGER_PRIVACY_NOTE =
  "The ledger contains usage totals, model names, project names, branches, " +
  "and local project paths. It does not contain prompt or response text.";

/** User-facing first-run storage decision derived from the resolved ledger. */
export function ledgerLocationPrompt(
  resolved: ResolvedUsageRoot,
): LedgerLocationPrompt {
  const isDefault = resolved.source === "default";
  const location = isDefault ? "On this computer" : "Existing usage history";
  return {
    message: "Where should usage history be stored?",
    detail:
      `${location}:\n${resolved.root}\n\n` +
      `${SHARED_LEDGER_NOTE}\n\n${LEDGER_PRIVACY_NOTE}`,
    buttons: [
      isDefault ? "Use Local Storage" : "Use This Folder",
      "Choose Another Folder...",
    ],
  };
}

export function ledgerMigrationPrompt(
  sourceRoot: string,
  destinationRoot: string,
): LedgerMigrationPrompt {
  return {
    message: "Migrate existing usage history?",
    detail:
      "Existing history will be merged into the new ledger without replacing " +
      `newer records.\n\nFrom: ${sourceRoot}\nTo: ${destinationRoot}`,
    buttons: ["Continue", "Cancel"],
    checkboxLabel: "Keep the original ledger as a backup",
    checkboxChecked: true,
  };
}
