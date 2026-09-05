/**
 * Runs inside the rendered portal and reports whether selecting a range on a
 * ledger with nothing in it draws a page or throws partway through drawing one.
 *
 * A render that aborts is invisible from the outside: the chip flips to active
 * and the page keeps whatever was on it, which on the first paint is the
 * sample figures index.html ships. So this watches for an uncaught exception
 * around each click and reads back the slots that would still be holding the
 * sample if the render never reached them.
 *
 * The listener is installed before the first click rather than at load,
 * because the initial render has already happened by then; the control range
 * is clicked explicitly so that render runs again under the watch.
 *
 * Every slot is stamped before the click that should rewrite it. The page
 * arrives at the first click already holding the default range's numbers,
 * which on an empty ledger are the same zeros the range under test owes, so a
 * render that stops partway would otherwise read back as one that finished.
 */
(async () => {
  /** The ranges to read, in the order they are clicked. ALL is the one whose
   *  window comes from the ledger; 30D is the control, a window of a fixed
   *  length over the same nothing. */
  const RANGES = ["ALL", "30D"];

  // The chips are in the markup, so their presence says nothing about whether
  // the page has rendered. The Spend KPIs are written by the renderer, so
  // theirs does.
  await waitForRender(() => document.querySelectorAll("#spendKpis .analysis-kpi").length > 0);

  const errors = [];
  window.addEventListener("error", (event) => {
    errors.push(String(event.error?.stack || event.error || event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    errors.push(String(event.reason?.stack || event.reason));
  });

  const text = (element) => (element ? element.textContent.trim() : "");

  /** What an unwritten slot reads back as. Any value but a rewritten one. */
  const NOT_REDRAWN = "NOT REDRAWN";

  /** The slots the assertions read, stamped so only the render can clear them. */
  function stampSlots() {
    const slots = [
      ".hero-number .value",
      ".hero-number .delta",
      ".folio .index",
      ".period-range span",
      ".metric b",
      ".metric small",
    ];
    for (const selector of slots) {
      for (const element of document.querySelectorAll(selector)) element.textContent = NOT_REDRAWN;
    }
  }

  function metric(label) {
    const found = [...document.querySelectorAll(".metric")]
      .find((entry) => text(entry.querySelector(".micro")) === label);
    return found ? { value: text(found.querySelector("b")), note: text(found.querySelector("small")) } : null;
  }

  /** Everything the reader can see that a half-finished render would leave
   *  holding the shipped sample. */
  function readings() {
    return {
      hero: text(document.querySelector(".hero-number .value")),
      heroDelta: text(document.querySelector(".hero-number .delta")),
      folio: text(document.querySelector(".folio .index")),
      periodRange: text(document.querySelector(".period-range span")),
      sessions: metric("Sessions"),
      tokens: metric("Tokens"),
      avgCost: metric("Avg / session"),
      bodyText: document.body.textContent,
    };
  }

  const ranges = {};
  for (const label of RANGES) {
    const chip = [...document.querySelectorAll(".ranges .chip")]
      .find((entry) => entry.textContent.trim() === label);
    if (!chip) {
      ranges[label] = null;
      continue;
    }
    const before = errors.length;
    stampSlots();
    chip.click();
    ranges[label] = {
      active: chip.classList.contains("active"),
      errors: errors.slice(before),
      ...readings(),
    };
  }

  return { ranges };
})()
