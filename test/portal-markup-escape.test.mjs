import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { escapeAttribute, escapeText } from "../portal/markup-escape.js";

const portalRoot = join(process.cwd(), "portal");

/**
 * Guard for issue #88.
 *
 * The portal's only escaper round-tripped a value through a text node, which
 * escapes `&`, `<`, `>`, and U+00A0 and nothing else, and it was used inside
 * quoted attributes carrying free text from the ledger. A project name is the
 * last segment of a working directory, taken verbatim, so a directory name
 * containing a double quote closed the attribute it sat in.
 */

// The reported name: legal on both first-class platforms, and enough on its
// own to grow an event handler out of a data attribute.
const HOSTILE = 'proj" onmouseover="alert(1)';

test("a value in a quoted attribute cannot close that attribute", () => {
  const escaped = escapeAttribute(HOSTILE);

  assert.ok(!escaped.includes('"'), escaped);
  assert.ok(!escaped.includes("'"), escaped);
  assert.equal(escaped, "proj&quot; onmouseover=&quot;alert(1)");
  // The whole property in one line: the value contributes no quote, so the
  // only two in the tag are the delimiters the template wrote.
  const markup = `<button data-project="${escaped}">`;
  assert.equal(markup.match(/"/g).length, 2);
});

test("both quote forms are escaped, so either delimiter holds", () => {
  assert.equal(escapeAttribute(`a"b'c`), "a&quot;b&#39;c");
  assert.equal(escapeAttribute("a&b<c>d"), "a&amp;b&lt;c&gt;d");
  assert.equal(escapeAttribute("\u00a0"), "&nbsp;");
});

test("text position keeps the rule the text node applied", () => {
  assert.equal(escapeText("a&b<c>d"), "a&amp;b&lt;c&gt;d");
  assert.equal(escapeText("\u00a0"), "&nbsp;");
  // Between tags a quote is a quote; escaping it there would print an entity.
  assert.equal(escapeText(HOSTILE), HOSTILE);
});

test("the portal has one escaper module and no private second one", () => {
  const sources = readdirSync(portalRoot)
    .filter((name) => name.endsWith(".js") && name !== "markup-escape.js")
    .map((name) => [name, readFileSync(join(portalRoot, name), "utf8")]);

  const redefines = sources
    .filter(([, source]) => /function\s+escape(Html|Text|Attribute)\s*\(/.test(source))
    .map(([name]) => name);

  assert.deepEqual(redefines, []);
});

test("no quoted attribute is filled with the text-position escaper", () => {
  const sources = readdirSync(portalRoot)
    .filter((name) => name.endsWith(".js"))
    .map((name) => [name, readFileSync(join(portalRoot, name), "utf8")]);

  const offenders = sources
    .filter(([, source]) => /=["']\$\{escapeText\(/.test(source))
    .map(([name]) => name);

  assert.deepEqual(offenders, []);
});
