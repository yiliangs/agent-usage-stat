/**
 * Number formatting for the portal, with the width each result has to live in.
 *
 * A panel is sized once, in CSS, but the strings it holds are produced at
 * runtime from whatever the ledger recorded. When a formatter has no ceiling,
 * a large enough number silently outgrows its panel and either wraps to a
 * second line or is cut off (issue #26). So every formatter that feeds a
 * single-line slot is bounded here, and `SLOT_BUDGET` records what the slot
 * was measured to hold.
 *
 * The budgets are character counts taken from the narrowest rendering of each
 * slot across the window widths the desktop shell can present; re-measure with
 * `node scripts/measure-portal-layout.mjs` after changing panel geometry. They
 * are counted in digits, which are among the widest glyphs in the portal's
 * faces, so a budget met in digits is met in prose.
 */

/**
 * Widest string, in characters, that each single-line numeric slot holds.
 *
 * - `heroValue`   `.hero-number .value`, 55px serif in the narrowest hero column
 * - `metricValue` `.metric b`, 29px serif in half of the metric stack
 * - `metricNote`  `.metric small`, the comparison line beneath it
 * - `heroDelta`   `.hero-number .delta`, the comparison under the hero figure
 * - `concValue`   `.conc-row .value`, 15px mono in the fixed 88px last column
 *
 * `concValue` is 9 rather than the 10 that fits on Windows: the column is a
 * fixed 88px at every window width, and the same ten characters that fit there
 * in the Windows mono fallback are cut off by 2px in the macOS one. A budget
 * has to hold on the narrower of the two faces, not the machine it was
 * measured on.
 */
export const SLOT_BUDGET = {
  heroValue: 7,
  metricValue: 7,
  metricNote: 17,
  heroDelta: 17,
  concValue: 9,
};

/** Exact currency, cents included. For the slots with room to print it in
 *  full: the analysis KPIs, the tables, bar values and session detail. */
export function usd(value) {
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Currency bounded to `SLOT_BUDGET.heroValue` characters, for every figure
 * that sits in a fixed column: the headline at poster size, and the per
 * project value in the concentration rows.
 *
 * Cents are dropped once the whole-dollar part alone carries the magnitude,
 * and six figures and beyond compact, so the string stops growing where the
 * panel stops growing. Nothing is lost: the exact total is printed in full on
 * the Spend view, whose KPI panels are four times as wide, and the note above
 * the concentration ring still names the largest project's total to the cent.
 */
export function usdHeadline(value) {
  if (Math.abs(value) < 1e3) return usd(value);
  const whole = Math.round(value);
  if (Math.abs(whole) < 1e5) return "$" + whole.toLocaleString("en-US");
  return "$" + scaleToUnit(value, MONEY_UNITS);
}

/**
 * Token counts, which already reach the billions, so always compacted.
 *
 * The exponential tail past a quadrillion is unreachable from a real ledger,
 * but it is what makes the budget a bound rather than an expectation: without
 * it the largest named unit keeps accumulating digits.
 */
export function compact(value) {
  if (Math.abs(value) < 1e3) return Math.round(value).toLocaleString("en-US");
  return scaleToUnit(value, TOKEN_UNITS);
}

const MONEY_UNITS = [[1e12, "T", 1], [1e9, "B", 1], [1e6, "M", 1], [1e3, "K", 0]];
const TOKEN_UNITS = [[1e12, "T", 2], [1e9, "B", 2], [1e6, "M", 2], [1e3, "K", 1]];

/**
 * `value` in the largest unit that leaves it at most three integer digits.
 *
 * The unit is settled after rounding rather than before, because rounding is
 * what breaks the bound: 999.999 billion tokens formats to two decimals as
 * "1000.00B", a fourth digit the slot has no room for, so it is promoted to
 * "1.00T" instead. Past the largest named unit the value falls back to
 * exponential notation, which is what keeps the width finite for any input.
 */
function scaleToUnit(value, units) {
  for (let index = 0; index < units.length; index += 1) {
    const [scale, unit, digits] = units[index];
    if (Math.abs(value) < scale) continue;
    const text = (value / scale).toFixed(digits);
    if (Math.abs(Number(text)) < 1000) return text + unit;
    if (index === 0) return value.toExponential(0);
    const [larger, largerUnit, largerDigits] = units[index - 1];
    return (value / larger).toFixed(largerDigits) + largerUnit;
  }
  return value.toExponential(0);
}

/** Whole percent, for shares of a total. */
export function pct(value) {
  return Math.round(value * 100) + "%";
}

/**
 * How this period compares with the one before it, in one line.
 *
 * A near-empty prior period turns an ordinary week into four- and five-digit
 * percentages -- "63200% above prior period" was the reported case -- which no
 * comparison line has room for and which nobody reads as a percentage anyway.
 * Past a tenfold change the wording becomes a multiplier, and the multiplier
 * itself compacts, so the result stays inside `SLOT_BUDGET.metricNote` for
 * every finite input.
 */
export function periodDelta(current, previous) {
  if (!previous) return "No prior baseline";
  const scale = Math.abs(previous);
  const ratio = current / scale;
  if (ratio >= 10) return `×${compact(ratio)} vs prior`;
  const change = (current - previous) / scale;
  const size = Math.abs(change * 100);
  return `${change < 0 ? "−" : "+"}${size.toFixed(size < 10 ? 1 : 0)}% vs prior`;
}
