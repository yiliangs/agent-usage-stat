import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveDisplayName,
  displayModelName,
} from "../dist/providers/claude/model-names.js";

test("curated names stay authoritative", () => {
  assert.equal(displayModelName("claude-opus-5"), "Claude Opus 5");
  assert.equal(displayModelName("gpt-5.6-sol"), "GPT-5.6 Sol");
});

test("date and context suffixes still normalize into the table", () => {
  assert.equal(displayModelName("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
});

test("a model released between edits gets a derived label, not its raw id", () => {
  // claude-sonnet-5 shipped and sat unnamed for six weeks because nothing ties
  // this table to pricing.ts. An unknown id must degrade to a readable label.
  assert.equal(deriveDisplayName("claude-sonnet-6"), "Claude Sonnet 6");
  assert.equal(deriveDisplayName("claude-opus-5-2"), "Claude Opus 5.2");
  assert.equal(displayModelName("claude-haiku-9"), "Claude Haiku 9");
});

test("an unrecognisable id is returned unchanged rather than mangled", () => {
  assert.equal(deriveDisplayName("llama-3"), undefined);
  assert.equal(deriveDisplayName("claude"), undefined);
  assert.equal(deriveDisplayName("claude-quasar-1"), undefined);
  assert.equal(displayModelName("some-internal-build"), "some-internal-build");
});
