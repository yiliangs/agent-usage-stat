import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after, before } from "node:test";

import {
  PORTAL_ORIGIN,
  routePortalRequest,
} from "../dist/desktop/portal-request.js";

/**
 * The `aus://` path guard (#100).
 *
 * `routePortalRequest` is the only thing standing between renderer content and
 * the filesystem: it picks one of two roots, decodes the path, and refuses
 * anything that leaves the root it picked. The renderer draws
 * transcript-derived strings, so a request path is untrusted input.
 *
 * The table below is the hostile input. Where the outcome is a file, the test
 * asserts containment with a prefix comparison rather than with the guard's own
 * `isPathInside`, so a weakened guard cannot certify itself.
 */

let roots;
let fixture;

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), "aus-portal-request-"));
  roots = { assets: join(fixture, "assets"), data: join(fixture, "data") };
  await mkdir(roots.assets, { recursive: true });
  await mkdir(roots.data, { recursive: true });
  await writeFile(join(roots.assets, "index.html"), "<!doctype html>");
  await writeFile(join(roots.data, "sessions.json"), "[]");
  // The escape target: a sibling of both roots, reachable only by traversal.
  await writeFile(join(fixture, "secret.json"), "{}");
});

after(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function route(path, method = "GET") {
  return routePortalRequest(method, new URL(`${PORTAL_ORIGIN}${path}`), roots);
}

function contains(root, path) {
  return path === root || path.startsWith(root + sep);
}

test("no request escapes the root it resolved against", () => {
  const hostile = [
    "/..%2f..%2fetc/passwd",
    "/..%5c..%5cwindows%5cwin.ini",
    "/%2e%2e/%2e%2e/x",
    "/C:/Windows/win.ini",
    "//app/..",
    "/data/../index.html",
    "/data/..%2f..%2fsecret.json",
    "/data/%2e%2e/%2e%2e/secret.json",
    "/data/..%2fsecret.json",
    "/%zz",
    "/data/%zz",
    "/",
    "/index.html",
    "/assets/index-Df_Wxgke.js",
    "/data/sessions.json",
  ];

  for (const path of hostile) {
    const decision = route(path);
    if (decision.kind !== "file") continue;
    const root = decision.source === "data" ? roots.data : roots.assets;
    assert.ok(
      contains(root, decision.path),
      `${path} resolved to ${decision.path}, outside ${root}`,
    );
  }
});

test("percent-encoded separators are refused, not resolved", () => {
  // URL normalization collapses `..` segments and even `%2e%2e`, so an encoded
  // separator is what actually reaches the guard. This is the traversal.
  assert.equal(new URL(`${PORTAL_ORIGIN}/..%2f..%2fetc/passwd`).pathname,
    "/..%2f..%2fetc/passwd");

  assert.deepEqual(route("/..%2f..%2fetc/passwd"), { kind: "forbidden" });
  assert.deepEqual(route("/data/..%2f..%2fsecret.json"), { kind: "forbidden" });
  assert.deepEqual(route("/data/..%2fsecret.json"), { kind: "forbidden" });
});

test("a path the URL parser already collapsed stays in the asset root", () => {
  // `%2e%2e` is decoded by URL normalization itself, so these arrive with the
  // traversal gone. They must not become data reads or root reads either.
  assert.equal(new URL(`${PORTAL_ORIGIN}/%2e%2e/%2e%2e/x`).pathname, "/x");
  assert.equal(new URL(`${PORTAL_ORIGIN}/data/../index.html`).pathname,
    "/index.html");

  assert.deepEqual(route("/%2e%2e/%2e%2e/x"), {
    kind: "file",
    source: "assets",
    path: join(roots.assets, "x"),
    fallback: join(roots.assets, "index.html"),
  });
  assert.equal(route("/data/../index.html").source, "assets");
  assert.equal(route("/data/%2e%2e/%2e%2e/secret.json").source, "assets");
});

test("an absolute path is refused rather than joined", () => {
  // `//app/..` normalizes to `//`, which resolves to the filesystem root.
  assert.deepEqual(route("//app/.."), { kind: "forbidden" });

  // A Windows drive letter is only absolute on Windows; elsewhere it is an
  // ordinary directory name and containment is what matters.
  const drive = route("/C:/Windows/win.ini");
  if (process.platform === "win32") {
    assert.deepEqual(drive, { kind: "forbidden" });
  } else {
    assert.ok(contains(roots.assets, drive.path));
  }
});

test("a malformed percent sequence names no file", () => {
  // decodeURIComponent throws on these. Left unhandled it rejects the protocol
  // handler's promise instead of answering the request.
  assert.deepEqual(route("/%zz"), { kind: "not-found" });
  assert.deepEqual(route("/data/%zz"), { kind: "not-found" });
});

test("refresh is a POST, and the refusal says so", () => {
  assert.deepEqual(route("/api/refresh", "POST"), { kind: "refresh" });
  for (const method of ["GET", "HEAD", "DELETE", "PUT"]) {
    assert.deepEqual(
      route("/api/refresh", method),
      { kind: "method-not-allowed", allow: "POST" },
      `${method} /api/refresh`,
    );
  }
});

test("only the portal host is served", () => {
  const foreign = routePortalRequest(
    "GET",
    new URL("aus://evil/index.html"),
    roots,
  );

  assert.deepEqual(foreign, { kind: "not-found" });
});

test("the dashboard document answers both the origin and its own path", () => {
  const index = {
    kind: "file",
    source: "assets",
    path: join(roots.assets, "index.html"),
    fallback: join(roots.assets, "index.html"),
  };

  assert.deepEqual(route("/"), index);
  assert.deepEqual(route("/index.html"), index);
  assert.deepEqual(route("/assets/portal.js"), {
    kind: "file",
    source: "assets",
    path: join(roots.assets, "assets", "portal.js"),
    fallback: join(roots.assets, "index.html"),
  });
});

test("a snapshot read resolves or it does not exist", () => {
  // The single-page fallback belongs to the asset root alone. A missing
  // snapshot file that answered index.html would hand the portal HTML where it
  // asked for JSON.
  const sessions = route("/data/sessions.json");

  assert.deepEqual(sessions, {
    kind: "file",
    source: "data",
    path: join(roots.data, "sessions.json"),
  });
  assert.equal("fallback" in sessions, false);
});

test("the path guard imports no Electron API", async () => {
  // The guard was inside PortalRuntime, which imports `app` and `protocol`, so
  // nothing could drive it outside a packaged run. An import here takes it back.
  const source = await readFile(
    join(process.cwd(), "src", "desktop", "portal-request.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /from\s+["']electron["']/);
});
