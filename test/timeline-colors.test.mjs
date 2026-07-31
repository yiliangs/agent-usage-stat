import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectColorIndex,
  projectSeriesFor,
} from "../portal/timeline-colors.js";

test("project timeline colors stay stable and fold excess projects into Other", () => {
  const sessions = [
    { project: "Alpha" },
    { project: "Beta" },
    { project: "Alpha" },
    { project: "Gamma" },
    { project: "Delta" },
    { project: "Epsilon" },
  ];
  const index = buildProjectColorIndex(sessions);

  assert.deepEqual(
    sessions.map((session) => projectSeriesFor(session.project, index)),
    [
      { label: "Alpha", variable: "--project-1", fallback: "#2a78d6" },
      { label: "Beta", variable: "--project-2", fallback: "#eda100" },
      { label: "Alpha", variable: "--project-1", fallback: "#2a78d6" },
      { label: "Gamma", variable: "--project-3", fallback: "#e87ba4" },
      { label: "Delta", variable: "--project-4", fallback: "#008300" },
      { label: "Other projects", variable: "--muted", fallback: "#66717f" },
    ],
  );
});

test("visible timeline projects receive the fixed color slots first", () => {
  const history = [
    { project: "Historic" },
    { project: "Alpha" },
    { project: "Beta" },
    { project: "Gamma" },
    { project: "Delta" },
  ];
  const visible = [{ project: "Beta" }, { project: "Gamma" }];
  const index = buildProjectColorIndex(history, visible);

  assert.equal(projectSeriesFor("Beta", index).variable, "--project-1");
  assert.equal(projectSeriesFor("Gamma", index).variable, "--project-2");
  assert.equal(projectSeriesFor("Historic", index).variable, "--project-3");
  assert.equal(projectSeriesFor("Alpha", index).variable, "--project-4");
  assert.equal(projectSeriesFor("Delta", index).label, "Other projects");
});
