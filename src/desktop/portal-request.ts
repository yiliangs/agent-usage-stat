import { isAbsolute, relative, resolve } from "node:path";

/**
 * The `aus://` URL grammar and the routing decision behind every request.
 *
 * This is the only boundary between renderer content and the filesystem, so it
 * imports no Electron API and can be driven directly by a test.
 * `portal-runtime.ts` supplies the two roots and turns a decision into a
 * `Response`; nothing else re-derives which root a path belongs to.
 */

export const PORTAL_SCHEME = "aus";
export const PORTAL_HOST = "app";

export const PORTAL_ORIGIN = `${PORTAL_SCHEME}://${PORTAL_HOST}`;
export const PORTAL_URL = `${PORTAL_ORIGIN}/index.html`;
/** The status-area glance, the portal's second document. */
export const PANEL_URL = `${PORTAL_ORIGIN}/panel.html`;

const DATA_PREFIX = "/data/";
const REFRESH_PATH = "/api/refresh";
const INDEX_FILE = "index.html";

/** The two directories the protocol serves, and nothing above either. */
export interface PortalRoots {
  /** Built renderer assets, inside the application bundle. */
  assets: string;
  /** The generated analytics snapshot, under the user data directory. */
  data: string;
}

export type PortalRequestDecision =
  | { kind: "not-found" }
  | { kind: "method-not-allowed"; allow: string }
  | { kind: "refresh" }
  | { kind: "forbidden" }
  /** A snapshot read: never cached, and it resolves or it does not exist. */
  | { kind: "file"; source: "data"; path: string }
  /** An asset read, with the single-page fallback for a path that is no file. */
  | { kind: "file"; source: "assets"; path: string; fallback: string };

/**
 * Decide what a request names, without touching the disk.
 *
 * Percent-encoded separators survive URL normalization, so decoding happens
 * here and every decoded path is checked against the root it resolved from.
 */
export function routePortalRequest(
  method: string,
  url: URL,
  roots: PortalRoots,
): PortalRequestDecision {
  if (url.host !== PORTAL_HOST) return { kind: "not-found" };

  if (url.pathname === REFRESH_PATH) {
    if (method !== "POST") return { kind: "method-not-allowed", allow: "POST" };
    return { kind: "refresh" };
  }

  const fromData = url.pathname.startsWith(DATA_PREFIX);
  const root = fromData ? roots.data : roots.assets;
  const requested = requestedPath(url.pathname, fromData);
  if (requested === null) return { kind: "not-found" };

  const path = resolve(root, requested);
  if (!isPathInside(root, path)) return { kind: "forbidden" };

  if (fromData) return { kind: "file", source: "data", path };
  return {
    kind: "file",
    source: "assets",
    path,
    fallback: resolve(root, INDEX_FILE),
  };
}

/**
 * The path a request names, relative to its root, or null when the request
 * carries a malformed percent sequence. Such a request names no file, and
 * letting `decodeURIComponent` throw would reject the protocol handler instead.
 */
function requestedPath(pathname: string, fromData: boolean): string | null {
  const raw = fromData
    ? pathname.slice(DATA_PREFIX.length)
    : pathname === "/" || pathname === `/${INDEX_FILE}`
      ? INDEX_FILE
      : pathname.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function isPathInside(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}
