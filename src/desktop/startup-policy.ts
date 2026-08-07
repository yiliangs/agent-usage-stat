export type StartupMode = "cached" | "first-run";

export const startupMode = (hasSnapshot: boolean): StartupMode =>
  hasSnapshot ? "cached" : "first-run";
