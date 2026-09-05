/**
 * Runs inside the rendered portal and reports every figure that claims to
 * cover the selected period.
 *
 * The hero total, the heatmap's current-window panel, the cumulative chart's
 * PERIOD TOTAL annotation and the two trend charts are each drawn by their own
 * renderer from their own bucketing, and a reader takes all of them to be
 * measuring the same window. Whether they actually do is a fact of the page,
 * so this reads them back off it: the figures as strings, and, for the charts
 * that draw one mark per bucket, the marks themselves, so a guard can add them
 * up and compare the sum against the total printed above.
 *
 * `probeInput.range` names a range chip to click first; without it the page is
 * read on whichever range it opens with.
 */
(async () => {
  const range = (globalThis.probeInput && globalThis.probeInput.range) || null;

  // index.html ships placeholder copy that portal.js overwrites on the first
  // render, so waiting on the range chips being wired is what says the page is
  // ready to be read.
  await waitForRender(() => document.querySelectorAll(".ranges .chip").length > 0
    && document.querySelectorAll("#spendKpis .analysis-kpi").length > 0
    && document.querySelectorAll("#heatmapSummary b").length > 0);

  const text = (element) => (element ? element.textContent.trim() : null);
  const all = (selector) => [...document.querySelectorAll(selector)];

  if (range) {
    const chip = all(".ranges .chip").find((entry) => entry.textContent.trim() === range);
    if (!chip) return { selectedRange: null };
    chip.click();
  }

  function kpiNote(selector, label) {
    const kpi = all(`${selector} .analysis-kpi`).find((entry) => text(entry.querySelector(".micro")) === label);
    return kpi ? text(kpi.querySelector("b")) : null;
  }

  const heatmapPanels = all("#heatmapSummary div").map((panel) => ({
    label: text(panel.querySelector("span")),
    value: text(panel.querySelector("b")),
  }));

  const cumulativeAnnotation = all(".cumulative-plot text.annotation")
    .map((node) => node.textContent.trim())
    .find((value) => value.startsWith("PERIOD TOTAL"));

  return {
    selectedRange: text(all(".ranges .chip").find((chip) => chip.classList.contains("active"))),
    hero: text(document.querySelector(".hero-number .value")),
    periodRange: text(document.querySelector(".period-range span")),
    heatmapPanels,
    cumulativeAnnotation: cumulativeAnnotation || null,
    cumulativePoints: all(".cumulative-plot circle").length,
    cumulativeMeta: text(document.querySelector("#cumulativeMeta")),
    // One mark per bucket per model family, each carrying its own value, so a
    // guard can add the chart up and compare it against the printed total.
    spendChartMarks: all(".plot rect.chart-mark").map((mark) => mark.dataset.tip),
    spendChartTitle: text(document.querySelector(".plot title")),
    spendFieldUnit: text(document.querySelector("#spendFieldUnit")),
    spendTotal: kpiNote("#spendKpis", "Total spend"),
    spendTrendMeta: text(document.querySelector("#spendTrendMeta")),
    spendTrendPoints: all("#spendTrend circle").length,
    tokenTotal: kpiNote("#tokenKpis", "Total tokens"),
    tokenTrendMeta: text(document.querySelector("#dailyTokenMeta")),
    tokenTrendTitle: text(document.querySelector("#dailyTokenTitle")),
    // The hit buckets are one per drawn interval whether or not it recorded
    // anything, and each names its own interval in the first line of its tip.
    tokenTrendBuckets: all("#tokenTrend rect.traffic-hit-bucket").map((bucket) => bucket.dataset.tip.split("\n")[0]),
    tokenTrendBars: all("#tokenTrend rect.traffic-bar").length,
    cacheRows: all("#cacheDays .analysis-bar-row, #cacheDays .analysis-bar").length,
  };
})()
