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
 * - `folioIndex`  `.folio .index`, the plate's session index
 * - `concValue`   `.conc-row .value`, 15px mono in the fixed 88px last column
 * - `glanceHero`  `.glance-hero b`, 27px serif in half the status-area panel
 * - `glanceNote`  `.glance-note`, the line under a hero figure or a band label
 * - `glanceMeta`  `.glance-meta`, a band's own figures, right of its label
 * - `glanceShare` `.glance-share`, one model's percent
 * - `glanceDetail` `.glance-detail`, the latest session's figures, full width
 * - `machineField` `.top-meta b`, the machine field in the page header
 *
 * `folioIndex` is the only budget that belongs to a row rather than to an
 * element. The index shares a flex row with its "Report plate" label, and both
 * shrink together, so the label breaks onto a second line at the same length
 * the index does: 26 characters at 1280 and 1920, where the hero column is
 * narrowest. The budget is the 25 that holds at every width. No fixture a
 * browser can render carries the ledger that would reach it, so the number is
 * checked by writing it into the slot: `test/portal-count-slot-layout.test.mjs`.
 *
 * `concValue` is 9 rather than the 10 that fits on Windows: the column is a
 * fixed 88px at every window width, and the same ten characters that fit there
 * in the Windows mono fallback are cut off by 2px in the macOS one. A budget
 * has to hold on the narrower of the two faces, not the machine it was
 * measured on.
 *
 * The `glance` slots belong to the status-area panel, which is one fixed size
 * on every screen, so their budgets have no window width to vary with. Its
 * headline figures sit two to a row, in half a 360px panel, so they compact
 * rather than printing every digit; the dashboard is where a count is read in
 * full. `glanceMeta` and `glanceDetail` are the slots that concatenate.
 *
 * `machineField` is a slot whose text is a sentence built around a count
 * rather than a bare figure, and it is bounded here for the reason the figures
 * are: the header is sized once and cannot grow, while the field takes
 * whatever hostname the ledger recorded. Its budget is the character count the
 * rendered slot was measured to hold, in `test/portal-header.test.mjs`.
 */
export const SLOT_BUDGET = {
  heroValue: 7,
  metricValue: 7,
  metricNote: 17,
  heroDelta: 17,
  folioIndex: 25,
  concValue: 9,
  glanceHero: 7,
  glanceNote: 17,
  glanceMeta: 17,
  glanceShare: 4,
  glanceDetail: 26,
  machineField: 16,
};

/** `text` cut to `budget` characters, with an ellipsis standing for the rest.
 *  The last resort for a slot whose text is not a number the formats can
 *  compact: a hostname the ledger chose, or a sentence a caller composed. */
const clipToBudget = (text, budget) =>
  text.length <= budget ? text : text.slice(0, budget - 1).trimEnd() + "…";

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
  // Round to the precision each branch prints before choosing between them,
  // for the reason `scaleToUnit` settles its unit after rounding: a value in
  // the half-cent band below a comma boundary takes the sub-thousand branch
  // and then rounds up across it, printing the "$1,000.00" the branch exists
  // to avoid.
  const cents = Math.round(value * 100) / 100;
  if (Math.abs(cents) < 1e3) return usd(cents);
  const whole = Math.round(cents);
  if (Math.abs(whole) < 1e5) return "$" + whole.toLocaleString("en-US");
  return "$" + scaleToUnit(cents, MONEY_UNITS);
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

/**
 * A count of things, printed in full while the slot has room for every digit.
 *
 * A count is the one figure a reader expects to see exactly, so unlike a token
 * volume it does not compact on principle: it prints with grouping for as long
 * as the panel holds it, and compacts only once it does not. The bound is
 * `SLOT_BUDGET.metricValue`, the narrower of the two slots a count feeds, so
 * one format serves both and neither has to know where the other's ceiling is.
 *
 * A million sessions is where the two branches meet, and it is the case the
 * inline `toLocaleString` this replaced got wrong: nine characters in a slot
 * measured to hold seven, cut off against the magnitude meter (#94).
 */
export function tally(value) {
  const whole = Math.round(value);
  const plain = whole.toLocaleString("en-US");
  return plain.length <= SLOT_BUDGET.metricValue ? plain : compact(whole);
}

/**
 * The report plate's `current / total` session index.
 *
 * Both sides are counts, so both are tallies. The two-digit zero padding is
 * the plate's own typography rather than a width: it applies to a single digit
 * and to nothing else, so a small ledger keeps reading `01 / 05` while a large
 * one reads `1.00M / 1.00M`.
 */
export function folioIndex(current, total) {
  return `${plate(current)} / ${plate(total)}`;
}

const plate = (value) => tally(value).padStart(2, "0");

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

/** The distinct machines in a set of sessions, as the header prints them. */
const machineNames = (machines) => [
  ...new Set(machines.filter(Boolean).map((name) => String(name).toUpperCase())),
];

/**
 * The header's machine field: one name, or how many machines wrote the ledger.
 *
 * A ledger on a shared drive is written by several machines, which is a
 * supported configuration rather than an edge case. Printing the busiest
 * machine's name there states a fact that is only true of a single-machine
 * ledger, and the reader is given no sign the others exist (#138). So the name
 * is reserved for the single-machine case and anything plural is reported as a
 * count, which is the one thing about a set of machines that fits the slot.
 *
 * The count form is `tally` plus " MACHINES", and that is what sets
 * `SLOT_BUDGET.machineField`. A hostname longer than the budget is cut to it:
 * the ledger chooses hostnames, and a long one would otherwise push the
 * header's identity block out of its own row. Nothing is lost, because the
 * Sessions table prints each session's machine in full.
 */
export function machineField(machines) {
  const names = machineNames(machines);
  if (!names.length) return "UNKNOWN";
  if (names.length > 1) return `${tally(names.length)} MACHINES`;
  return clipToBudget(names[0], SLOT_BUDGET.machineField);
}

/** The label above that field, which has to agree with it about number. The
 *  two are decided together here so a plural field cannot end up under a
 *  singular label. */
export function machineFieldLabel(machines) {
  return machineNames(machines).length > 1 ? "Machines" : "Machine";
}

