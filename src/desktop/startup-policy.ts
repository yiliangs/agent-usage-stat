export type StartupMode = "cached" | "first-run";

export const startupMode = (hasSnapshot: boolean): StartupMode =>
  hasSnapshot ? "cached" : "first-run";

export const firstRunPortalUrl = (
  portalUrl: string,
  setupReady: boolean,
): string => setupReady ? portalUrl : `${portalUrl}#settings`;

export const startupIconFilename = (shouldUseDarkColors: boolean): string =>
  shouldUseDarkColors ? "icon-dark.png" : "icon-light.png";
