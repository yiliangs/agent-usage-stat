import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createServer } from "vite";

/**
 * Brand-asset resolution guard for issue #57.
 *
 * The portal is served two ways from one `index.html`: Vite builds it into
 * `dist/portal/` for the packaged renderer, and Vite serves it from the source
 * tree during development. Only the build resolves asset paths on disk, so a
 * reference that leaves the Vite root works in the packaged application and
 * silently falls through to the SPA fallback in development, handing the header
 * `<img>` an HTML document. Reading the HTML cannot tell the two apart, so this
 * starts the real development server and fetches what the browser would fetch.
 */

const root = process.cwd();

/** The one brand SVG in the source tree, wherever it is kept. */
function brandSources(directory = root) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...brandSources(path));
    else if (entry.name === "logo.svg") found.push(path);
  }
  return found.sort();
}

/** Every asset URL the served page points at, as the browser resolves them. */
function referencedAssets(html) {
  const urls = [
    ...html.matchAll(/<img\s[^>]*\bsrc="([^"]+)"/gi),
    ...html.matchAll(/<link\s[^>]*\brel="icon"[^>]*\bhref="([^"]+)"/gi),
  ].map(([, url]) => url);
  return [...new Set(urls)].filter((url) => !/^(?:data:|https?:)/i.test(url));
}

async function withDevServer(run) {
  const server = await createServer({
    configFile: join(root, "portal", "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    return await run(`http://127.0.0.1:${server.httpServer.address().port}`);
  } finally {
    await server.close();
  }
}

test("the development server serves the brand asset the portal header references", async () => {
  const sources = brandSources();
  assert.deepEqual(sources.length, 1, `expected one brand source, found: ${sources.join(", ")}`);
  const brand = readFileSync(sources[0], "utf8");

  await withDevServer(async (origin) => {
    const page = await fetch(`${origin}/index.html`);
    assert.equal(page.status, 200);
    const references = referencedAssets(await page.text());
    assert.ok(references.length > 0, "the portal must reference its brand asset");

    for (const reference of references) {
      const response = await fetch(new URL(reference, `${origin}/index.html`));
      const contentType = response.headers.get("content-type") || "no content type";
      assert.equal(response.status, 200, `${reference} responded ${response.status}`);
      assert.ok(
        contentType.startsWith("image/svg+xml"),
        `${reference} served ${contentType}, so the browser gets no image`,
      );
      assert.equal(
        await response.text(),
        brand,
        `${reference} did not serve ${sources[0]}`,
      );
    }
  });
});
