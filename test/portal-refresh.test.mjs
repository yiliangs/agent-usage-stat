import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const root = process.cwd();

test("the running portal refreshes rebuilt data through its local API", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-portal-refresh-"));
  const dataRoot = join(home, "usage");
  const shardDir = join(dataRoot, "logbook.d");
  const shardPath = join(shardDir, "session.json");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  await mkdir(shardDir, { recursive: true });
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ dataRoot }),
  );
  await writeFile(shardPath, JSON.stringify(shard(1)), "utf8");

  const child = spawn(
    process.execPath,
    [
      join(root, "bin", "agent-usage-stat.js"),
      "portal",
      "--no-open",
      "--no-sync",
      "--port",
      String(port),
    ],
    {
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForReady(child, base);
    const repeated = await runPortalOnce(home, port);
    assert.equal(repeated.code, 0, repeated.output);
    assert.match(repeated.output, /already running/);

    const page = await fetch(base);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const portalHtml = await page.text();
    assert.match(portalHtml, /Session timeline/i);
    assert.match(portalHtml, /data-portal-view="sessions"/i);

    const initial = await fetch(`${base}/data/meta.json`).then((response) => response.json());
    assert.equal(initial.totalCost, 1);

    await writeFile(shardPath, JSON.stringify(shard(2)), "utf8");
    const refresh = await fetch(`${base}/api/refresh`, {
      method: "POST",
      headers: { Origin: base },
    });
    assert.equal(refresh.status, 200);
    const result = await refresh.json();
    assert.equal(result.updated, 0);
    assert.equal(result.totalCost, 2);

    const rebuilt = await fetch(`${base}/data/meta.json`, { cache: "no-store" }).then(
      (response) => response.json(),
    );
    assert.equal(rebuilt.totalCost, 2);

    const blocked = await fetch(`${base}/api/refresh`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
    });
    assert.equal(blocked.status, 403);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
    await rm(home, { recursive: true, force: true });
  }
});

function shard(cost) {
  return {
    session_id: "session",
    session_slug: "session",
    provider: "claude",
    project: "portal-refresh",
    machine: "test",
    start_time: "2026-07-24T12:00:00.000Z",
    end_time: "2026-07-24T12:01:00.000Z",
    duration_seconds: 60,
    duration_human: "1m",
    input_tokens: 100,
    output_tokens: 10,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 110,
    total_cost_usd: cost,
    models: ["claude-opus-5"],
    model_breakdowns: [],
    turns: [],
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function runPortalOnce(home, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "bin", "agent-usage-stat.js"),
        "portal",
        "--no-open",
        "--port",
        String(port),
      ],
      {
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

function waitForReady(child, base) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`portal did not start:\n${output}`));
    }, 10_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!output.includes(`Agent Usage Stat is running at ${base}`)) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`portal exited early with code ${code}:\n${output}`));
    });
  });
}
