import type { ResolvedUsageRoot } from "../utils/usage-root.js";
import type { SetupQuestion } from "./setup-question.js";

export type LedgerLocationChoice = "keep" | "choose";
export type LedgerMigrationChoice = "migrate" | "cancel";

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
): SetupQuestion<LedgerLocationChoice> {
  const isDefault = resolved.source === "default";
  return {
    message: "Where should usage history be stored?",
    facts: [
      {
        label: isDefault ? "On this computer" : "Existing usage history",
        value: resolved.root,
      },
    ],
    detail: [SHARED_LEDGER_NOTE, LEDGER_PRIVACY_NOTE],
    options: [
      { value: "keep", label: isDefault ? "Use Local Storage" : "Use This Folder" },
      { value: "choose", label: "Choose Another Folder..." },
    ],
  };
}

export function ledgerMigrationPrompt(
  sourceRoot: string,
  destinationRoot: string,
): SetupQuestion<LedgerMigrationChoice> {
  return {
    message: "Migrate existing usage history?",
    facts: [
      { label: "From", value: sourceRoot },
      { label: "To", value: destinationRoot },
    ],
    detail: [
      "Existing history will be merged into the new ledger without replacing " +
      "newer records.",
    ],
    options: [
      { value: "migrate", label: "Continue" },
      { value: "cancel", label: "Cancel" },
    ],
    toggle: {
      label: "Keep the original ledger as a backup",
      checked: true,
    },
  };
}
