import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultUsageRoot,
  resolveUsageRoot,
  resolveUsageRootFromDisk,
} from "../dist/utils/usage-root.js";

const SHARED_DIR_NAME = "agent-usage-stat";
const MAC_RUNTIME = { platform: "darwin", home: "/Users/alex" };
const MAC_DEFAULT =
  "/Users/alex/Library/Application Support/Agent Usage Stat/ledger";

/** A scratch directory the test owns, removed however the test ends. */
function withWorkspace(run) {
  const workspace = mkdtempSync(join(tmpdir(), "usage-root-"));
  try {
    return run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** A drive mount whose shared root already carries a ledger. */
function mountWithLedger(workspace, name) {
  const mount = join(workspace, name);
  mkdirSync(join(mount, SHARED_DIR_NAME, "logbook.d"), { recursive: true });
  return mount;
}

/** A drive mount whose shared root exists but holds no ledger. */
function mountWithoutLedger(workspace, name) {
  const mount = join(workspace, name);
  mkdirSync(join(mount, SHARED_DIR_NAME), { recursive: true });
  return mount;
}

test("new desktop users receive a platform-native application ledger directory", () => {
  assert.equal(
    defaultUsageRoot({
      platform: "win32",
      home: "C:\\Users\\Alex",
      localAppData: "C:\\Users\\Alex\\AppData\\Local",
    }),
    "C:\\Users\\Alex\\AppData\\Local\\Agent Usage Stat\\ledger",
  );
  assert.equal(
    defaultUsageRoot({ platform: "darwin", home: "/Users/alex" }),
    MAC_DEFAULT,
  );
});

test("configuration outranks a detected shared root, which outranks the default", () => {
  withWorkspace((workspace) => {
    const populated = mountWithLedger(workspace, "drive-with-ledger");
    const bare = mountWithoutLedger(workspace, "drive-without-ledger");
    const unmounted = join(workspace, "drive-that-is-not-mounted");
    const shared = join(populated, SHARED_DIR_NAME);

    const cases = [
      {
        name: "an explicit dataRoot wins over a mount already holding a ledger",
        config: { dataRoot: join(workspace, "explicit") },
        runtime: { ...MAC_RUNTIME, driveMounts: [populated] },
        expected: { root: join(workspace, "explicit"), source: "config" },
      },
      {
        name: "a tilde-prefixed dataRoot expands against the home in effect",
        config: { dataRoot: "~/Ledgers/usage" },
        runtime: { ...MAC_RUNTIME, driveMounts: [populated] },
        expected: { root: "/Users/alex/Ledgers/usage", source: "config" },
      },
      {
        name: "whitespace is not a configured root",
        config: { dataRoot: "   " },
        runtime: { ...MAC_RUNTIME, driveMounts: [populated] },
        expected: { root: shared, source: "detected" },
      },
      {
        name: "the first mount already holding logbook.d is the shared root",
        config: {},
        runtime: { ...MAC_RUNTIME, driveMounts: [bare, populated] },
        expected: { root: shared, source: "detected" },
      },
      {
        name: "a mount without logbook.d is not a shared root",
        config: {},
        runtime: { ...MAC_RUNTIME, driveMounts: [bare, unmounted] },
        expected: { root: MAC_DEFAULT, source: "default" },
      },
      {
        name: "no mount candidate at all leaves the platform default",
        config: {},
        runtime: { ...MAC_RUNTIME, driveMounts: [] },
        expected: { root: MAC_DEFAULT, source: "default" },
      },
    ];

    for (const { name, config, runtime, expected } of cases) {
      assert.deepEqual(resolveUsageRoot(config, runtime), expected, name);
    }

    // Detection only reads. It never creates the cloud directory it looked for.
    assert.equal(existsSync(join(bare, SHARED_DIR_NAME, "logbook.d")), false);
    assert.equal(existsSync(unmounted), false);
  });
});

test("a config file on disk resolves, and a malformed one falls through", () => {
  withWorkspace((workspace) => {
    const populated = mountWithLedger(workspace, "drive-with-ledger");
    const shared = join(populated, SHARED_DIR_NAME);

    const valid = join(workspace, "valid.config.json");
    writeFileSync(valid, JSON.stringify({ dataRoot: "~/Ledgers/from-disk" }));
    assert.deepEqual(
      resolveUsageRootFromDisk({
        ...MAC_RUNTIME,
        driveMounts: [populated],
        configPath: valid,
      }),
      { root: "/Users/alex/Ledgers/from-disk", source: "config" },
    );

    // A half-written config must not strand captures: detection still runs.
    const malformed = join(workspace, "malformed.config.json");
    writeFileSync(malformed, '{ "dataRoot": ');
    assert.deepEqual(
      resolveUsageRootFromDisk({
        ...MAC_RUNTIME,
        driveMounts: [populated],
        configPath: malformed,
      }),
      { root: shared, source: "detected" },
    );

    const absent = join(workspace, "absent.config.json");
    assert.deepEqual(
      resolveUsageRootFromDisk({
        ...MAC_RUNTIME,
        driveMounts: [],
        configPath: absent,
      }),
      { root: MAC_DEFAULT, source: "default" },
    );
  });
});
