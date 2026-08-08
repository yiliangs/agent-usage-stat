export type CaptureMode = "automatic" | "on-open";

export interface AppConfig {
  version: string;
  /**
   * Directory containing the per-session `logbook.d/` usage shards.
   * A leading `~` is expanded to the home directory. Set this to a synced
   * folder to combine usage from several machines.
   */
  dataRoot?: string;
  /** How provider transcripts are reconciled into the durable ledger. */
  captureMode?: CaptureMode;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: "2.0.0",
  captureMode: "automatic",
};

export const resolvedCaptureMode = (
  config: Pick<AppConfig, "captureMode">,
): CaptureMode => config.captureMode === "on-open" ? "on-open" : "automatic";
