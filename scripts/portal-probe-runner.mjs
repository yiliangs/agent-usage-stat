/**
 * Renders the built portal in headless Chrome and runs a probe inside it.
 *
 * Layout is a fact of the renderer, so it cannot be checked by reading CSS: the
 * same declaration fits at one window width and clips at another. Chromium is
 * the only renderer the shipped app ever uses, so measuring in it is measuring
 * the real thing. Electron would be the closer match but cannot open a window
 * headlessly, so this drives Chrome over the DevTools protocol instead, using
 * only the Node standard library.
 *
 * The harness is shared; each guard supplies its own probe script, which runs
 * in the page and returns whatever that guard needs to assert. The harness
 * navigates and waits for the load event; the probe calls `waitForRender` with
 * the condition that means "drawn" for the thing it measures.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

/** Every window width the desktop shell can present, plus each CSS breakpoint
 *  edge. `minWidth` in src/desktop/main.ts is 1040; the portal restyles itself
 *  at 1280 and 1920, and both edges have starved a panel before. */
export const SUPPORTED_WIDTHS = [1040, 1280, 1440, 1920, 2560];

const CHROME_CANDIDATES = [
  process.env.AGENT_USAGE_STAT_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/** The renderer binary, or null when the machine has no Chrome to measure in. */
export function findChrome() {
  return CHROME_CANDIDATES.find((path) => path && existsSync(path)) || null;
}

/** Serve the built portal with `data/` swapped for the caller's fixture, which
 *  is how the portal itself loads: `fetch('./data/sessions.json')`. */
function serve(portalDir, data) {
  const files = new Map(
    Object.entries(data).map(([name, value]) => [`/data/${name}`, JSON.stringify(value)]),
  );
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (files.has(pathname)) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(files.get(pathname));
      return;
    }
    const file = join(portalDir, normalize(pathname === "/" ? "index.html" : pathname.slice(1)));
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return server;
}

/** A minimal DevTools client. Node ships a WebSocket, so no dependency is
 *  needed for the handful of commands this takes. */
async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("devtools socket failed")), { once: true });
  });
  const pending = new Map();
  const waiting = new Map();
  let lastId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
      return;
    }
    const resolve = waiting.get(message.method);
    if (resolve) {
      waiting.delete(message.method);
      resolve(message.params);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++lastId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  /** Resolve the next occurrence of a devtools event. Register before issuing
   *  the command that causes it, or the event arrives with nobody listening. */
  const once = (method) => new Promise((resolve) => waiting.set(method, resolve));
  return { send, once, close: () => socket.close() };
}

/** Resolve when `promise` settles, or after `ms`, whichever comes first. A
 *  probe that starts early reports a half-drawn page, so the wait is worth
 *  having; a probe that never starts reports nothing at all, so it is capped. */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  // Racing does not cancel the loser, and a live timer keeps Node running long
  // after the probe has answered.
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Defines `waitForRender` for the probe about to run in the page.
 *
 * The portal ships its views hidden and reveals them on its first render, so
 * every probe has to start after that render rather than after a fixed sleep.
 * A sleep long enough for a loaded CI runner is dead time on every other
 * machine, and one tuned on a warm machine reads a blank page on a cold one.
 */
const PROBE_PREAMBLE = `
globalThis.waitForRender = async function (rendered, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try { ready = Boolean(rendered()); } catch { ready = false; }
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
`;

/** Measure one width in a fresh browser so no earlier width leaks state. */
async function probeWidth({ chrome, port, width, height, script }) {
  const profile = await mkdtemp(join(tmpdir(), "aus-layout-"));
  const browser = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(() => reject(new Error("chrome never reported a devtools endpoint")), 30_000);
      browser.stderr.on("data", (chunk) => {
        buffered += chunk;
        const match = buffered.match(/ws:\/\/\S+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    const client = await connect(endpoint);
    const target = await client.send("Target.createTarget", { url: "about:blank" });
    const attached = await client.send("Target.attachToTarget", {
      targetId: target.result.targetId,
      flatten: true,
    });
    const session = attached.result.sessionId;
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, session);
    await client.send("Page.enable", {}, session);
    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, session);
    await withDeadline(loaded, 30_000);
    const evaluated = await client.send(
      "Runtime.evaluate",
      { expression: PROBE_PREAMBLE + script, awaitPromise: true, returnByValue: true },
      session,
    );
    client.close();
    const failure = evaluated.result?.exceptionDetails;
    if (failure) throw new Error(`portal probe failed: ${JSON.stringify(failure).slice(0, 400)}`);
    return evaluated.result.result.value;
  } finally {
    browser.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render the portal at each width and return one probe result per width.
 * `data` supplies `sessions.json` and `meta.json` exactly as the desktop build
 * writes them; `probe` is the URL of a script file to evaluate in the page.
 */
export async function runPortalProbe({ portalDir, data, probe, widths = SUPPORTED_WIDTHS, height = 960 }) {
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome binary found");
  const script = await readFile(probe, "utf8");
  const server = serve(portalDir, data);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const results = [];
    for (const width of widths) {
      results.push({ width, ...(await probeWidth({ chrome, port, width, height, script })) });
    }
    return results;
  } finally {
    server.close();
  }
}
