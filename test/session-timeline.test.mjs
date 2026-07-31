import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const portalRoot = join(process.cwd(), "portal");

test("Session timeline exposes model and project color modes", async () => {
  const [html, script] = await Promise.all([
    readFile(join(portalRoot, "index.html"), "utf8"),
    readFile(join(portalRoot, "portal.js"), "utf8"),
  ]);

  assert.match(html, /aria-label="Session timeline color coding"/);
  assert.match(html, /data-rhythm-color="model"[^>]*>Model</);
  assert.match(html, /data-rhythm-color="project"[^>]*>Project</);
  assert.match(script, /rhythmColor:\s*'model'/);
  assert.match(
    script,
    /\$\$\('\[data-rhythm-color\]'\)[\s\S]*state\.rhythmColor = button\.dataset\.rhythmColor[\s\S]*renderWorkRhythm/,
  );
  assert.match(script, /\$\('#rhythmColorToggle'\)\.hidden = monthView/);
});
