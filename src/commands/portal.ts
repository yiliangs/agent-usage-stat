import { createServer } from "http";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { resolve, extname, isAbsolute, relative } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { SyncCommand } from "./sync.js";
import { homeDir } from "../utils/paths.js";

export interface PortalOptions {
  port?: string;
  open?: boolean;
  sync?: boolean;
}

interface PortalRefreshResult {
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

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export class PortalCommand {
  private refreshPromise: Promise<PortalRefreshResult> | null = null;

  async execute(options: PortalOptions): Promise<void> {
    const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const assetsRoot = resolve(packageRoot, "dist", "portal");
    const dataRoot = resolve(homeDir(), ".agent-usage-stat", "portal-data");
    const builder = resolve(packageRoot, "portal", "scripts", "build-data.mjs");
    const port = this.parsePort(options.port);
    const url = `http://127.0.0.1:${port}`;

    if (await this.isPortalRunning(url)) {
      console.log(chalk.green(`Agent Usage Stat is already running at ${url}`));
      if (options.open !== false) this.openBrowser(url);
      return;
    }

    if (!existsSync(resolve(assetsRoot, "index.html"))) {
      throw new Error("Portal assets are missing. Run npm run build:portal.");
    }

    if (options.sync !== false) {
      await new SyncCommand().execute({ quiet: true });
    }
    await this.runDataBuilder(builder, dataRoot);

    const server = createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://localhost");

      if (url.pathname === "/api/refresh") {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" }).end("Method not allowed");
          return;
        }
        if (!this.isSameOrigin(request.headers.host, request.headers.origin)) {
          response.writeHead(403).end("Forbidden");
          return;
        }

        try {
          const result = await this.refresh(builder, dataRoot);
          this.writeJson(response, 200, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.writeJson(response, 500, { error: message });
        }
        return;
      }

      try {
        const fromData = url.pathname.startsWith("/data/");
        const root = fromData ? dataRoot : assetsRoot;
        const requestedPath = fromData
          ? url.pathname.slice("/data/".length)
          : url.pathname === "/"
            ? "index.html"
            : url.pathname.slice(1);
        let path = resolve(root, requestedPath);
        const pathFromRoot = relative(root, path);
        if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
          response.writeHead(403).end("Forbidden");
          return;
        }
        if (!fromData && !(await this.isFile(path))) {
          path = resolve(assetsRoot, "index.html");
        }
        const body = await readFile(path);
        const extension = extname(path);
        response.writeHead(200, {
          "Content-Type": MIME[extension] || "application/octet-stream",
          "Cache-Control":
            fromData || extension === ".html"
              ? "no-store"
              : "public, max-age=3600",
        });
        response.end(body);
      } catch {
        response.writeHead(404).end("Not found");
      }
    });

    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolveReady);
    });

    console.log(chalk.green(`Agent Usage Stat is running at ${url}`));
    console.log(chalk.gray("Press Ctrl+C to stop."));
    if (options.open !== false) this.openBrowser(url);
  }

  private refresh(builder: string, dataRoot: string): Promise<PortalRefreshResult> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh(builder, dataRoot).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async performRefresh(
    builder: string,
    dataRoot: string,
  ): Promise<PortalRefreshResult> {
    const updated = await new SyncCommand().execute({ quiet: true });
    await this.runDataBuilder(builder, dataRoot);
    const meta = JSON.parse(
      await readFile(resolve(dataRoot, "meta.json"), "utf-8"),
    ) as PortalMeta;
    return {
      updated,
      generatedAt: meta.generatedAt || new Date().toISOString(),
      sessions: meta.sessions ?? 0,
      totalCost: meta.totalCost ?? 0,
    };
  }

  private async runDataBuilder(builder: string, output: string): Promise<void> {
    await new Promise<void>((resolveDone, reject) => {
      const child = spawn(process.execPath, [builder, "--output", output], {
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolveDone();
        else reject(new Error(`Portal data build failed with exit code ${code}`));
      });
    });
  }

  private isSameOrigin(host: string | undefined, origin: string | undefined): boolean {
    if (!origin) return true;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  private writeJson(
    response: import("http").ServerResponse,
    status: number,
    value: unknown,
  ): void {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  }

  private async isPortalRunning(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(`${url}/data/meta.json`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const meta = (await response.json()) as PortalMeta;
      return (
        typeof meta.generatedAt === "string" &&
        typeof meta.sessions === "number"
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private openBrowser(url: string): void {
    const command =
      process.platform === "darwin"
        ? { file: "open", args: [url] }
        : process.platform === "win32"
          ? { file: "cmd", args: ["/c", "start", "", url] }
          : { file: "xdg-open", args: [url] };
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private parsePort(value?: string): number {
    const port = Number(value || 4179);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${value}`);
    }
    return port;
  }

  private async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
}
