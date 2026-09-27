/**
 * The application menu, as a template built from the platform and the actions
 * behind its commands.
 *
 * Electron-free by design (the menu types are erased at build time), so which
 * commands a platform carries can be checked without building a native menu.
 */

import type { MenuItemConstructorOptions } from "electron";
import {
  offersIntegrationRemoval,
  REMOVE_INTEGRATIONS_LABEL,
} from "./integration-removal.js";

export interface ApplicationMenuActions {
  refresh: () => void;
  openSettings: () => void;
  removeIntegrations: () => void;
}

export function applicationMenuTemplate(
  platform: string,
  appName: string,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] {
  const applicationItems: MenuItemConstructorOptions[] = [
    {
      label: "Refresh Data",
      accelerator: "CmdOrCtrl+R",
      click: () => actions.refresh(),
    },
    { type: "separator" },
    {
      label: "Settings...",
      accelerator: "CmdOrCtrl+,",
      click: () => actions.openSettings(),
    },
  ];
  const removalItems: MenuItemConstructorOptions[] =
    offersIntegrationRemoval(platform)
      ? [
        { type: "separator" },
        {
          label: REMOVE_INTEGRATIONS_LABEL,
          click: () => actions.removeIntegrations(),
        },
      ]
      : [];

  return platform === "darwin"
    ? [
      {
        label: appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          ...applicationItems,
          ...removalItems,
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]
    : [
      {
        label: "Application",
        submenu: [
          ...applicationItems,
          ...removalItems,
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "viewMenu" },
      { role: "help", submenu: [{ role: "about" }] },
    ];
}
