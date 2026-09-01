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
      { label: "Alpha", variable: "--project-1", fallback: "#3f6d99" },
      { label: "Beta", variable: "--project-2", fallback: "#b4832c" },
      { label: "Alpha", variable: "--project-1", fallback: "#3f6d99" },
      { label: "Gamma", variable: "--project-3", fallback: "#a8577a" },
      { label: "Delta", variable: "--project-4", fallback: "#4a7a52" },
      { label: "Other projects", variable: "--muted", fallback: "#66717f" },
    ],
  );
});

test("the four color slots go to the largest projects, not the first ones named", () => {
  // The portal drew three of the five rows on one chart in the same neutral,
  // because the slots had gone to whichever projects an earlier session named
  // first. Ranking by volume is what makes a project's color agree with its
  // position in every table that sorts by the same figure.
  const sessions = [
    { project: "Small", totalTokens: 10 },
    { project: "Tiny", totalTokens: 1 },
    { project: "Huge", totalTokens: 900 },
    { project: "Large", totalTokens: 400 },
    { project: "Medium", totalTokens: 200 },
    { project: "Huge", totalTokens: 100 },
  ];
  const index = buildProjectColorIndex(sessions);

  assert.deepEqual(
    ["Huge", "Large", "Medium", "Small", "Tiny"].map((project) => projectSeriesFor(project, index).variable),
    ["--project-1", "--project-2", "--project-3", "--project-4", "--muted"],
  );
});

test("one project keeps one color: nothing claims a slot ahead of volume", () => {
  // The timeline used to hand its visible week the first claim on the four
  // slots, so which projects were colored depended on which week was on
  // screen, and every other view inherited that skew. Volume is now the only
  // rule, and it is the same rule wherever the index is read.
  const ledger = [
    { project: "Huge", totalTokens: 900 },
    { project: "Large", totalTokens: 400 },
    { project: "Medium", totalTokens: 200 },
    { project: "Small", totalTokens: 10 },
    { project: "Tiny", totalTokens: 1 },
  ];

  assert.equal(buildProjectColorIndex.length, 1, "the index takes a session list and nothing to bias it with");
  assert.deepEqual(
    ["Huge", "Large", "Medium", "Small", "Tiny"].map((project) => projectSeriesFor(project, buildProjectColorIndex(ledger)).variable),
    ["--project-1", "--project-2", "--project-3", "--project-4", "--muted"],
  );
  assert.deepEqual(
    buildProjectColorIndex(ledger.slice().reverse()),
    buildProjectColorIndex(ledger),
    "the order the sessions arrive in cannot change the assignment",
  );
});
