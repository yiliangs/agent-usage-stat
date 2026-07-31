import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const portalRoot = join(process.cwd(), "portal");

test("overview leads with token volume using the API-value hero typography", async () => {
  const [html, script] = await Promise.all([
    readFile(join(portalRoot, "index.html"), "utf8"),
    readFile(join(portalRoot, "portal.js"), "utf8"),
  ]);

  assert.match(html, /<span class="micro">Token volume<\/span>/);
  assert.doesNotMatch(html, /<div class="period-range"><strong>30D<\/strong>/);
  assert.match(
    script,
    /\$\('\.period-range strong'\)\.textContent = fmt\.compact\(current\.tokens\)/,
  );

  const tokenHero = declarations(html, ".period-range strong");
  const valueHero = declarations(html, ".hero-number .value");
  for (const property of ["font-family", "font-size", "line-height", "letter-spacing"]) {
    assert.equal(tokenHero[property], valueHero[property], property);
  }
});

function declarations(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected styles for ${selector}`);
  return Object.fromEntries(
    [...match[1].matchAll(/([\w-]+):\s*([^;]+);/g)].map((entry) => [
      entry[1],
      entry[2].trim(),
    ]),
  );
}
