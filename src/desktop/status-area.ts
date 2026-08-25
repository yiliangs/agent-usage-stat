import {
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  screen,
  shell,
} from "electron";
import { PANEL_SIZE, panelPlacement } from "./status-area-policy.js";

/** Tray icons are drawn at 16 logical pixels; the shell scales from there. */
const ICON_SIZE = 16;
/**
 * A click on the icon while the panel is open arrives after the blur that
 * already closed it, so without this the panel would reopen on the click that
 * was meant to dismiss it.
 */
const REOPEN_GUARD_MS = 250;
/**
 * A window can lose focus while it is still appearing, and the shell can hand
 * focus back to whatever was in front when it was never taken from it. Neither
 * is a reader clicking away, so a blur this soon after the panel opens is not
 * a dismissal.
 */
const DISMISS_GRACE_MS = 250;

export interface StatusAreaOptions {
  /** The panel document, served over the application's own protocol. */
  panelUrl: string;
  /** The themed application icon, re-read whenever the OS theme changes. */
  iconPath(): string;
  openDashboard(): void;
  quit(): void;
}

/**
 * The notification-area icon and the glance panel behind it.
 *
 * The panel is an ordinary portal document in a frameless window that is
 * created once and then shown and hidden, rather than built on each click: it
 * reads the whole session snapshot, and a reader who wanted a glance should
 * not wait for that. Keeping it loaded is also what keeps the application
 * resident once the dashboard is closed.
 *
 * Every decision about where the panel lands belongs to `status-area-policy`,
 * which has no Electron in it; this class supplies the rectangles the shell
 * reports and applies the answer.
 */
export class StatusArea {
  private tray: Tray | null = null;
  private panel: BrowserWindow | null = null;
  private panelLoad: Promise<void> | null = null;
  private shownAt = 0;
  private hiddenAt = 0;
  private announced = false;

  constructor(private readonly options: StatusAreaOptions) {}

  isActive(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  /** The loaded panel window, for callers that need to inspect it. */
  panelWindow(): BrowserWindow | null {
    return this.panel !== null && !this.panel.isDestroyed() ? this.panel : null;
  }

  /**
   * Place the icon and start loading the panel behind it.
   *
   * A shell that refuses the icon is not a reason to fail startup: the
   * dashboard is the application, and the status area is a shortcut into it.
   */
  install(): void {
    if (this.isActive()) return;
    this.tray = new Tray(this.icon());
    this.tray.setToolTip("Agent Usage Stat");
    this.tray.setIgnoreDoubleClickEvents(true);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Usage Glance", click: () => void this.show() },
      { label: "Open Dashboard", click: () => this.options.openDashboard() },
      { type: "separator" },
      { label: "Quit Agent Usage Stat", click: () => this.options.quit() },
    ]));
    this.tray.on("click", () => void this.toggle());
    this.createPanel();
  }

  /** Follow the OS theme, so the icon keeps its contrast against the taskbar. */
  applyTheme(): void {
    if (this.isActive()) this.tray?.setImage(this.icon());
  }

  async toggle(): Promise<void> {
    const panel = await this.ready();
    if (!panel) return;
    if (panel.isVisible()) {
      this.hide();
      return;
    }
    if (Date.now() - this.hiddenAt < REOPEN_GUARD_MS) return;
    await this.show();
  }

  async show(): Promise<void> {
    const panel = await this.ready();
    if (!panel) return;
    const bounds = this.tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    const display = screen.getDisplayMatching(
      bounds.width > 0 && bounds.height > 0
        ? bounds
        : screen.getPrimaryDisplay().workArea,
    );
    const { x, y } = panelPlacement(bounds, display.workArea, PANEL_SIZE);
    panel.setBounds({ ...PANEL_SIZE, x, y });
    this.shownAt = Date.now();
    panel.show();
    panel.focus();
    // The figures on screen are already current in the ordinary case, so the
    // panel appears at once and corrects itself if the ledger moved on.
    void this.refresh();
  }

  hide(): void {
    const panel = this.panelWindow();
    if (!panel || !panel.isVisible()) return;
    this.hiddenAt = Date.now();
    panel.hide();
  }

  /** Ask an already-loaded panel to read the ledger again. */
  async refresh(): Promise<void> {
    const panel = await this.ready();
    if (!panel) return;
    await panel.webContents
      .executeJavaScript("window.agentUsageStatRefreshPanel?.()")
      .catch(() => undefined);
  }

  /**
   * Say where the application went the first time it goes resident.
   *
   * Windows files a newly registered icon under the hidden-icons overflow and
   * offers no supported way to pin it, so a user who closes the dashboard
   * otherwise has no way to tell the application apart from one that quit.
   */
  announceResidency(): void {
    if (this.announced || !this.isActive()) return;
    this.announced = true;
    this.tray?.displayBalloon({
      title: "Agent Usage Stat is still running",
      content:
        "Its icon is in the notification area, under the arrow beside the " +
        "clock. Drag it onto the taskbar to keep it in view.",
      iconType: "info",
    });
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    const panel = this.panelWindow();
    this.panel = null;
    this.panelLoad = null;
    panel?.destroy();
  }

  /**
   * The panel once its document is in place.
   *
   * Loading is never on the launch path: nobody has asked for the panel at
   * startup, and the dashboard behind it is what the user is waiting for. Only
   * the calls that read or show the panel wait for it.
   */
  private async ready(): Promise<BrowserWindow | null> {
    await this.panelLoad?.catch(() => undefined);
    return this.panelWindow();
  }

  private createPanel(): void {
    const panel = new BrowserWindow({
      ...PANEL_SIZE,
      show: false,
      frame: false,
      // The panel document draws its own hairline frame at the edge of its
      // content, and it has to be the only thing drawn there. A frameless
      // window still keeps a one-point non-client margin, on the left and the
      // bottom but not the top or the right, and Windows paints its window
      // border over the outermost point of the window rect: on the two edges
      // where the content is flush with that rect the border lands on the
      // document's frame and hides it, leaving one stray rule down the left
      // side (#139). A transparent window reserves no margin at all, so the
      // window rect is the content rect, the document owns every edge, and
      // PANEL_SIZE means on screen what `panelPlacement` clamps against.
      // Nothing shows through: the panel's own paper covers the whole canvas.
      transparent: true,
      backgroundColor: "#00000000",
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Agent Usage Stat",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    panel.on("blur", () => {
      if (Date.now() - this.shownAt >= DISMISS_GRACE_MS) this.hide();
    });
    panel.webContents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") this.hide();
    });
    panel.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    this.panel = panel;
    this.panelLoad = panel.loadURL(this.options.panelUrl);
  }

  private icon(): Electron.NativeImage {
    return nativeImage
      .createFromPath(this.options.iconPath())
      .resize({ width: ICON_SIZE, height: ICON_SIZE });
  }
}
