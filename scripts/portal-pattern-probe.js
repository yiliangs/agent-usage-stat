/**
 * Runs inside the rendered portal and reports whether a Pattern caption can
 * move the card it sits in.
 *
 * The captions state computed numbers, so they run to one line on some weeks
 * and two on others. Left to size themselves they took the whole card with
 * them, and paging one week moved the heatmap and everything below it by the
 * height of a line. Whether the reservation that fixes this is large enough is
 * a fact of the rendered box: a caption that happens to fit reads identically
 * in the stylesheet to one with room to spare.
 *
 * So this measures twice. It pages through the weeks and reports what each
 * page drew, which catches a real shift on real data. Then it writes a short
 * caption and a caption at the length budget into each caption slot in turn
 * and reports the card height under both, which catches a reservation that is
 * too small even when the fixture never happens to produce a long sentence.
 *
 * Offsets are measured from the top of the view rather than the viewport,
 * because the page scrolls and a viewport offset would report the scroll as a
 * shift.
 */
(async () => {
  await waitForRender(() => document.querySelectorAll(".calendar-cell").length > 0);

  const tab = document.querySelector('[data-portal-view="pattern"]');
  if (!tab) return { error: "no Pattern tab" };
  tab.click();
  await waitForRender(() => {
    const view = document.querySelector("#patternView");
    return view && !view.hidden && document.querySelectorAll("#patternHeat .pattern-heat-cells i").length > 0;
  });

  const view = document.querySelector("#patternView");
  const origin = () => view.getBoundingClientRect().top;
  const offset = (selector) => {
    const element = document.querySelector(selector);
    return element ? Math.round(element.getBoundingClientRect().top - origin()) : null;
  };
  const height = (selector) => {
    const element = document.querySelector(selector);
    return element ? Math.round(element.getBoundingClientRect().height) : null;
  };
  const cardOf = (selector) => document.querySelector(selector).closest(".analysis-card");

  function measure() {
    return {
      week: document.querySelector("#patternWeekLabel").textContent.trim(),
      captionText: document.querySelector("#patternHeatCaption").textContent.trim().length,
      captionHeight: height("#patternHeatCaption"),
      heatTop: offset("#patternHeat"),
      belowTop: offset("#patternDayChart"),
      viewHeight: height("#patternView"),
    };
  }

  const older = document.querySelector('[data-pattern-week="older"]');
  const pages = [measure()];
  for (let step = 0; step < 12; step += 1) {
    if (older.disabled) break;
    older.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    pages.push(measure());
  }
  document.querySelector("#patternWeekAll").click();
  await new Promise((resolve) => setTimeout(resolve, 60));

  /**
   * Prose of a given length, in the mix of words and figures the captions
   * actually print. A filler of one repeated letter would wrap at a different
   * column than a real sentence and would measure the wrong thing.
   */
  function filler(length) {
    const words = "the 16.75B tokens across 168 hour-slots half of that volume sits in 28 of them heaviest slot Wednesday 23:00 above the scale weekday evenings 22% work hours 56% of the week".split(" ");
    let text = "";
    for (let index = 0; text.length < length; index += 1) text += `${words[index % words.length]} `;
    return text.slice(0, length);
  }

  /**
   * The longest caption each slot may print, in characters.
   *
   * One number cannot serve all four: the budget is what fits in the reserved
   * box, and a four-column card holds barely half of what the full-width one
   * does. These are per slot for the same reason `SLOT_BUDGET` in
   * `usage-format.js` is, and the guard asserts both halves of the bargain,
   * that the box holds the budget and that the renderer stays inside it.
   */
  const BUDGETS = {
    "#patternHeatCaption": 210,
    "#patternWeekCaption": 140,
    "#patternSplitCaption": 210,
    "#patternProjectCaption": 210,
  };

  const reservations = Object.entries(BUDGETS).map(([selector, budget]) => {
    const element = document.querySelector(selector);
    const original = element.textContent;
    element.textContent = "Short.";
    const short = Math.round(cardOf(selector).getBoundingClientRect().height);
    element.textContent = filler(budget);
    const full = Math.round(cardOf(selector).getBoundingClientRect().height);
    const captionHeight = height(selector);
    element.textContent = original;
    return { selector, short, full, captionHeight, budget, rendered: original.trim().length };
  });

  return { pages, reservations, budgets: BUDGETS };
})();
