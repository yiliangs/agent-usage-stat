export type StartupMode = "cached" | "first-run";

export const startupMode = (hasSnapshot: boolean): StartupMode =>
  hasSnapshot ? "cached" : "first-run";

export const firstRunPortalUrl = (
  portalUrl: string,
  setupReady: boolean,
): string => setupReady ? portalUrl : `${portalUrl}#settings`;
