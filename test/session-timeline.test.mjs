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
  assert.doesNotMatch(script, /\$\('#rhythmColorToggle'\)\.hidden = monthView/);
});

test("month timeline shares the week view color controls", async () => {
  const script = await readFile(join(portalRoot, "portal.js"), "utf8");

  assert.match(
    script,
    /renderMonthRhythm\(dateKeys, segmentsByDate, observedThrough, projectColors\)/,
  );
  assert.match(
    script,
    /function renderMonthRhythmDays[\s\S]*rhythmSeriesFor\(segment\.session, projectColors\)/,
  );
});

test("timeline follows the user's time zone without publishing a fixed location", async () => {
  const script = await readFile(join(portalRoot, "portal.js"), "utf8");

  assert.match(script, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(script, /locationLabelForTimeZone\(LOCAL_TIME_ZONE\)/);
  assert.match(script, /return 'N\/A'/);
  assert.match(script, /<b>\$\{LOCAL_LOCATION\}<\/b>/);
  assert.doesNotMatch(script, /America\/Chicago|<b>Chicago<\/b>/);
});

test("month timeline blends full-width layers while preserving grouped detail", async () => {
  const [html, script] = await Promise.all([
    readFile(join(portalRoot, "index.html"), "utf8"),
    readFile(join(portalRoot, "portal.js"), "utf8"),
  ]);

  assert.match(
    html,
    /\.rhythm-overlap-layer\s*\{[\s\S]*mix-blend-mode:\s*multiply/,
  );
  assert.match(
    html,
    /prefers-color-scheme:\s*dark[\s\S]*\.rhythm-overlap-layer\s*\{\s*mix-blend-mode:\s*screen/,
  );
  assert.match(
    script,
    /band\.segments\.map[\s\S]*rhythm-overlap-layer[\s\S]*data-session-ids="\$\{band\.ids\.join\(','\)\}"/,
  );
  assert.match(script, /'\.rhythm-event, \.rhythm-overlap-band'/);
});
