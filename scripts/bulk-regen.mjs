#!/usr/bin/env node
// One-shot bulk regen for missing logbook entries. Reads the existing logbook
// to skip already-recorded sessions, then runs regen-session.mjs for each
// remaining transcript on disk. Designed to be safe to re-run.
import { spawn } from "child_process";
import { readFile, readdir, stat } from "fs/promises";
import { join, basename, extname } from "path";
import { existsSync } from "fs";
import { resolveUsageRootFromDisk } from "../dist/utils/usage-root.js";
import { homeDir } from "../dist/utils/paths.js";

const HOME = homeDir();
const PROJECTS = join(HOME, ".claude", "projects");
const SHARD_DIR = join(resolveUsageRootFromDisk().root, "logbook.d");
const REGEN = join(process.cwd(), "scripts", "regen-session.mjs");
const CURRENT_SESSION = process.argv[2] || ""; // optional skip
const MIN_AGE_SEC = 120; // skip transcripts modified in the last 2 min

async function loadRecordedIds() {
  // logbook.d/ is the single source of truth; shard filename = session_id
  // (the legacy logbook.csv was folded in by migrate-csv-to-shards.mjs).
  if (!existsSync(SHARD_DIR)) return new Set();
  const ids = new Set();
  for (const f of await readdir(SHARD_DIR)) {
    if (extname(f) === ".json") ids.add(basename(f, ".json"));
  }
  return ids;
}

async function findTranscripts() {
  const dirs = await readdir(PROJECTS, { withFileTypes: true });
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS, d.name);
    const files = await readdir(dir);
    for (const f of files) {
      if (extname(f) !== ".jsonl") continue;
      const full = join(dir, f);
      const st = await stat(full);
      out.push({
        sessionId: basename(f, ".jsonl"),
        path: full,
        mtime: st.mtimeMs,
      });
    }
  }
  return out;
}

function runRegen(sessionId, transcriptPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REGEN, sessionId, transcriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.stdout.on("data", () => {}); // discard
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

(async () => {
  const recorded = await loadRecordedIds();
  const transcripts = await findTranscripts();
  const now = Date.now();

  const todo = transcripts.filter(
    (t) =>
      !recorded.has(t.sessionId) &&
      t.sessionId !== CURRENT_SESSION &&
      now - t.mtime > MIN_AGE_SEC * 1000,
  );
  todo.sort((a, b) => a.mtime - b.mtime);

  console.log(`recorded: ${recorded.size}`);
  console.log(`on disk:  ${transcripts.length}`);
  console.log(`to regen: ${todo.length}`);
  console.log("");

  let ok = 0,
    fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    const tag = `[${i + 1}/${todo.length}]`;
    process.stdout.write(`${tag} ${t.sessionId} ... `);
    const t0 = Date.now();
    const { code, stderr } = await runRegen(t.sessionId, t.path);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (code === 0) {
      ok++;
      console.log(`ok (${dt}s)`);
    } else {
      fail++;
      console.log(`FAIL (${dt}s) code=${code}`);
      if (stderr) console.log(stderr.split("\n").slice(0, 5).join("\n"));
    }
  }

  console.log("");
  console.log(`done: ${ok} ok, ${fail} failed`);
})();
