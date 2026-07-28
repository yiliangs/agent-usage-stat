import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const portalPath = join(process.cwd(), "dist", "portal", "index.html");

function variablesFrom(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
  );
}

function rgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

test("the portal follows the system dark preference with a warm charcoal paper palette", async () => {
  const html = await readFile(portalPath, "utf8");
  const lightMatch = html.match(/:root\s*\{([\s\S]*?)\n\s*\}/);
  const darkMatch = html.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\s*\}/);

  assert.ok(lightMatch, "expected the existing light palette");
  const light = variablesFrom(lightMatch[1]);
  assert.deepEqual(
    { field: light.field, paper: light.paper, idle: light.idle },
    { field: "#dfddd6", paper: "#f3f0e7", idle: "#d5d6d2" },
    "expected dark mode to preserve the established light surfaces",
  );

  assert.ok(darkMatch, "expected a system dark-mode media query");
  const dark = variablesFrom(darkMatch[1]);
  assert.match(dark.field, /^#[0-9a-f]{6}$/i);
  assert.match(dark.paper, /^#[0-9a-f]{6}$/i);
  assert.ok(dark.texture, "expected dark mode to retain a dedicated paper texture");

  for (const key of ["field", "paper"]) {
    const [red, green, blue] = rgb(dark[key]);
    assert.ok(Math.max(red, green, blue) < 64, `${key} should remain charcoal-dark`);
    assert.ok(red > blue && green > blue, `${key} should lean warmer than neutral charcoal`);
  }

  assert.match(darkMatch[1], /color-scheme:\s*dark/);
  assert.match(html, /@media\s+print\s*\{[\s\S]*?color-scheme:\s*light/);
});
