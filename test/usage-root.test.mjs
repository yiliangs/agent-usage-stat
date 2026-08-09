import test from "node:test";
import assert from "node:assert/strict";
import { defaultUsageRoot } from "../dist/utils/usage-root.js";

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
    "/Users/alex/Library/Application Support/Agent Usage Stat/ledger",
  );
});
