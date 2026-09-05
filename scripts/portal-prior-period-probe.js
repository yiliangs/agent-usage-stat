/**
 * Runs inside the rendered portal and reports what each period comparison says
 * on one range after another.
 *
 * A range is chosen by clicking a chip in the header, and every comparison on
 * the page is redrawn from that one click, so the only way to read what a
 * range actually reports is to click it and read the page back. This selects
 * each range it is asked for and reports the hero figure, the hero comparison,
 * the metric comparisons beneath it, and the Spend and Tokens headline notes,
 * leaving the guard to decide which of them owed the reader no baseline.
 */
(async () => {
  /** The ranges to read, in the order they are clicked. ALL is the one under
   *  test; 30D is the control, a fixed range over the same ledger. */
  const RANGES = ["ALL", "30D"];

  // index.html ships the hero with placeholder copy that portal.js overwrites
  // on the first render, so waiting on the range chips being wired is what
  // says the page is ready to be clicked.
  await waitForRender(() => document.querySelectorAll(".ranges .chip").length > 0
    && document.querySelectorAll("#spendKpis .analysis-kpi").length > 0);

  const text = (element) => (element ? element.textContent.trim() : "");

  function noteIn(selector, label) {
    const kpi = [...document.querySelectorAll(`${selector} .analysis-kpi`)]
      .find((entry) => text(entry.querySelector(".micro")) === label);
    return kpi ? text(kpi.querySelector("small")) : null;
  }

  /** Every comparison the page draws from the selected period, as a reader
   *  sees it. The range chip's handler renders synchronously, so the page is
   *  already redrawn by the time the click returns. */
  function comparisons() {
    return {
      hero: text(document.querySelector(".hero-number .value")),
      heroDelta: text(document.querySelector(".hero-number .delta")),
      metricDeltas: [...document.querySelectorAll(".metric")].map((metric) => ({
        label: text(metric.querySelector(".micro")),
        note: text(metric.querySelector("small")),
      })),
      spendNote: noteIn("#spendKpis", "Total spend"),
      tokenNote: noteIn("#tokenKpis", "Total tokens"),
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
    chip.click();
    ranges[label] = { active: chip.classList.contains("active"), ...comparisons() };
  }

  return { ranges };
})()
