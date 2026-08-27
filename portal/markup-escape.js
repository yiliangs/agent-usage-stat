/**
 * Escaping for the two positions the portal interpolates a value into.
 *
 * The dashboard builds its markup as template strings, so a value from the
 * ledger arrives as source rather than as a DOM node, and where it lands
 * decides what it has to survive. Between tags it only has to survive `<` and
 * `&`. Inside an attribute it also has to survive the quote that delimits the
 * attribute.
 *
 * The single escaper this replaces round-tripped through a text node, which is
 * exactly the text rule and nothing more, and it was used in attribute
 * position throughout (#88). A project name is the last segment of a working
 * directory taken verbatim, and a directory name may contain a double quote on
 * both first-class platforms, so one such name closed the attribute it sat in
 * and the remainder parsed as markup.
 */

const TEXT = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\u00a0': '&nbsp;',
}

const ATTRIBUTE = { ...TEXT, '"': '&quot;', "'": '&#39;' }

/** For a value interpolated between tags. */
export function escapeText(value) {
  return String(value).replace(/[&<>\u00a0]/g, (character) => TEXT[character])
}

/**
 * For a value interpolated inside a quoted attribute. Both quote forms are
 * escaped, so the result is safe in either delimiter rather than only in the
 * one the current call site happens to use.
 */
export function escapeAttribute(value) {
  return String(value).replace(/["'&<>\u00a0]/g, (character) => ATTRIBUTE[character])
}
