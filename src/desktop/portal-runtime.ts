import { app, protocol } from "electron";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { LOGBOOK_SHARD_DIR } from "../core/usage-ledger.js";
import { resolveUsageRootFromDisk } from "../utils/usage-root.js";
import type { HelperRuntime } from "./helper-runtime.js";
import { buildPortalData } from "./portal-data.js";
import {
  PORTAL_HOST,
  PORTAL_SCHEME,
  type PortalRequestDecision,
  routePortalRequest,
} from "./portal-request.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface PortalRefreshResult {
  updated: number;
  generatedAt: string;
  sessions: number;
  totalCost: number;
}

export type PortalRequestHandler = (
  request: Request,
  url: URL,
) => Promise<Response | null>;

export function registerPortalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PORTAL_SCHEME,
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

  constructor(
    private readonly helperRuntime: HelperRuntime,
    private readonly requestHandler?: PortalRequestHandler,
  ) {}

  async registerProtocol(): Promise<void> {
    await protocol.handle(PORTAL_SCHEME, (request) => this.handleRequest(request));
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
    if (url.host === PORTAL_HOST) {
      const handled = await this.requestHandler?.(request, url);
      if (handled) return handled;
    }

    const decision = routePortalRequest(request.method, url, {
      assets: this.assetsRoot(),
      data: this.dataRoot(),
    });

    switch (decision.kind) {
      case "not-found":
        return new Response("Not found", { status: 404 });
      case "method-not-allowed":
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: decision.allow },
        });
      case "forbidden":
        return new Response("Forbidden", { status: 403 });
      case "refresh":
        try {
          return jsonResponse(await this.refresh());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResponse({ error: message }, 500);
        }
      case "file":
        return serveFile(decision);
    }
  }

  private async performRefresh(): Promise<PortalRefreshResult> {
    const usageRoot = resolveUsageRootFromDisk().root;
    await mkdir(join(usageRoot, LOGBOOK_SHARD_DIR), { recursive: true });
    const helper = await this.helperRuntime.run(["sync", "--quiet"]);
    if (helper.code !== 0) {
      throw new Error(helper.stderr.trim() || "Usage synchronization failed.");
    }

    const meta = await buildPortalData({
      root: usageRoot,
      outDir: this.dataRoot(),
    });

    return {
      updated: helper.updated,
      generatedAt: meta.generatedAt,
      sessions: meta.sessions,
      totalCost: meta.totalCost,
    };
  }

  private dataRoot(): string {
    return join(app.getPath("userData"), "portal-data");
  }
}

/** The one place a routed path becomes bytes. Both roots are read the same way,
 *  and only the cache policy separates a snapshot read from an asset read. */
async function serveFile(
  decision: Extract<PortalRequestDecision, { kind: "file" }>,
): Promise<Response> {
  let path = decision.path;
  if (decision.source === "assets" && !(await isFile(path))) {
    path = decision.fallback;
  }
  const fromData = decision.source === "data";

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
