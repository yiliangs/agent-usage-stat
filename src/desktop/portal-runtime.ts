import { app, protocol } from "electron";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveUsageRootFromDisk } from "../utils/usage-root.js";
import type { HelperRuntime } from "./helper-runtime.js";

const APP_SCHEME = "aus";
const APP_HOST = "app";
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export const PORTAL_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const PORTAL_URL = `${PORTAL_ORIGIN}/index.html`;

export interface PortalRefreshResult {
  updated: number;
  generatedAt: string;
  sessions: number;
  totalCost: number;
}

interface PortalMeta {
  generatedAt?: string;
  sessions?: number;
  totalCost?: number;
}

export function registerPortalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

/** Owns the renderer's private protocol and generated analytics snapshot. */
export class PortalRuntime {
  private refreshPromise: Promise<PortalRefreshResult> | null = null;

  constructor(private readonly helperRuntime: HelperRuntime) {}

  async registerProtocol(): Promise<void> {
    await protocol.handle(APP_SCHEME, (request) => this.handleRequest(request));
  }

  refresh(): Promise<PortalRefreshResult> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async hasSnapshot(): Promise<boolean> {
    const root = this.dataRoot();
    const [sessions, meta] = await Promise.all([
      isFile(join(root, "sessions.json")),
      isFile(join(root, "meta.json")),
    ]);
    return sessions && meta;
  }

  assetsRoot(): string {
    return join(app.getAppPath(), "dist", "portal");
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });

    if (url.pathname === "/api/refresh") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      try {
        return jsonResponse(await this.refresh());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse({ error: message }, 500);
      }
    }

    const fromData = url.pathname.startsWith("/data/");
    const root = fromData ? this.dataRoot() : this.assetsRoot();
    const requestedPath = fromData
      ? url.pathname.slice("/data/".length)
      : url.pathname === "/" || url.pathname === "/index.html"
        ? "index.html"
        : url.pathname.slice(1);
    let path = resolve(root, decodeURIComponent(requestedPath));

    if (!isPathInside(root, path)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!fromData && !(await isFile(path))) {
      path = resolve(root, "index.html");
    }

    try {
      const content = await readFile(path);
      const extension = extname(path).toLowerCase();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
          "Cache-Control": fromData || extension === ".html"
            ? "no-store"
            : "public, max-age=3600",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  private async performRefresh(): Promise<PortalRefreshResult> {
    const usageRoot = resolveUsageRootFromDisk().root;
    await mkdir(join(usageRoot, "logbook.d"), { recursive: true });
    const helper = await this.helperRuntime.run(["sync", "--quiet"]);
    if (helper.code !== 0) {
      throw new Error(helper.stderr.trim() || "Usage synchronization failed.");
    }

    const builderPath = join(
      app.getAppPath(),
      "portal",
      "scripts",
      "build-data.mjs",
    );
    const builder = await import(pathToFileURL(builderPath).href) as {
      buildPortalData(options: {
        root: string;
        outDir: string;
      }): Promise<PortalMeta>;
    };
    const meta = await builder.buildPortalData({
      root: usageRoot,
      outDir: this.dataRoot(),
    });

    return {
      updated: helper.updated,
      generatedAt: meta.generatedAt || new Date().toISOString(),
      sessions: meta.sessions ?? 0,
      totalCost: meta.totalCost ?? 0,
    };
  }

  private dataRoot(): string {
    return join(app.getPath("userData"), "portal-data");
  }
}

function isPathInside(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
