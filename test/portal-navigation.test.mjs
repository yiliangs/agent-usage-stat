import test from "node:test";
import assert from "node:assert/strict";
import { selectPortalView } from "../portal/portal-navigation.js";

test("active Settings returns to the previously selected portal page", () => {
  const settings = selectPortalView(
    { currentView: "sessions", settingsReturnView: null },
    "settings",
  );

  assert.deepEqual(settings, {
    currentView: "settings",
    settingsReturnView: "sessions",
  });
  assert.deepEqual(selectPortalView(settings, "settings"), {
    currentView: "sessions",
    settingsReturnView: null,
  });
});
