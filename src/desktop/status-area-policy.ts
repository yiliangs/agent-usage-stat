/**
 * Where the status-area icon exists, what closing the dashboard means once it
 * does, and where its panel opens.
 *
 * Electron-free by design, so the geometry that decides the panel's corner can
 * be checked against real display arrangements without a screen to look at.
 */

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * The panel's size, fixed at every screen size and on every display.
 *
 * It is wide enough for two figures side by side and tall enough for the three
 * bands it carries, with room to spare for a taller font fallback. The
 * `glance` entries in `portal/usage-format.js` bound what those figures may
 * print at this width.
 */
export const PANEL_SIZE = { width: 320, height: 368 };

/** Gap between the panel and both the icon and the edges of the work area. */
export const PANEL_MARGIN = 8;

/**
 * Whether this platform carries the icon.
 *
 * Windows is the platform the icon was asked for and the one it is verified
 * on. The macOS menu bar is the same surface with different assets and its own
 * conventions, and is tracked separately as issue #47.
 */
export const hasStatusArea = (platform: string): boolean => platform === "win32";

/**
 * Whether closing the dashboard leaves the application running.
 *
 * An icon that disappears with the window it was meant to replace is worth
 * nothing, so wherever the status area holds the application, closing the
 * dashboard hands it over rather than quitting. macOS already stays resident
 * on its own.
 */
export const closesToStatusArea = (platform: string): boolean =>
  hasStatusArea(platform);

/**
 * The panel's top-left corner, given where the shell put the icon.
 *
 * The panel is centred on its icon and pushed to whichever side of it has the
 * room, which is what puts it above a bottom taskbar and below a top one. It
 * is then held inside the work area, so it never lands under the taskbar or
 * off the display. An icon with no reported size is one the shell has not
 * placed, and the panel falls back to the corner the status area occupies.
 */
export function panelPlacement(
  icon: Rectangle,
  workArea: Rectangle,
  panel: Size,
  margin = PANEL_MARGIN,
): Point {
  const left = workArea.x + margin;
  const right = workArea.x + workArea.width - panel.width - margin;
  const top = workArea.y + margin;
  const bottom = workArea.y + workArea.height - panel.height - margin;

  if (icon.width <= 0 || icon.height <= 0) {
    return { x: Math.max(left, right), y: Math.max(top, bottom) };
  }

  const belowMiddle =
    icon.y + icon.height / 2 > workArea.y + workArea.height / 2;
  return {
    x: clamp(icon.x + icon.width / 2 - panel.width / 2, left, right),
    y: clamp(
      belowMiddle
        ? icon.y - panel.height - margin
        : icon.y + icon.height + margin,
      top,
      bottom,
    ),
  };
}

/** Held inside `[low, high]`, and at `low` when the range has collapsed: a
 *  work area smaller than the panel has to show one corner, and the corner
 *  worth keeping is the one the content starts at. */
function clamp(value: number, low: number, high: number): number {
  return Math.round(Math.max(low, Math.min(high, value)));
}
