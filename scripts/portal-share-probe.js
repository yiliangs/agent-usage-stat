/**
 * Runs inside the rendered portal and reports every share it prints.
 *
 * Shares are computed at render time from the loaded ledger, so what the
 * reader sees is a fact of the running page rather than of the source: the
 * same expression prints correct percentages for a busy month and rescaled
 * ones for a quiet week. This collects the percentage each composition
 * actually draws, plus the ring geometry behind the model pie, and leaves the
 * guard to decide whether they add up.
 */
(async () => {
  await waitForRender(() =>
    document.querySelectorAll(".model-pie-key .model-pie-row").length > 0 &&
    document.querySelectorAll("#spendMachines .composition-row").length > 0 &&
    document.querySelectorAll("#projectTopology tfoot td").length > 0,
  );

  const text = (element) => (element ? element.textContent.trim() : "");

  /** A composition row prints "<share> / <value>"; the share is the half a
   *  reader compares against the other rows. */
  const compositionRows = (selector) =>
    [...document.querySelectorAll(`${selector} .composition-row`)].map((row) => ({
      key: text(row.querySelector("span")),
      share: text(row.querySelector("b")).split("/")[0].trim(),
      meterWidth: row.querySelector(".composition-meter i")?.style.width || "",
    }));

  const modelRows = [...document.querySelectorAll(".model-pie-key .model-pie-row")].map((row) => ({
    key: text(row.querySelector("span")),
    share: text(row.querySelector("b")),
  }));

  // The conic gradient's last stop is where the painted arc ends. A rescaled
  // denominator leaves the remainder of the donut unpainted, which no
  // percentage string reveals.
  const ringStops = [...document.querySelector(".model-ring").style.background.matchAll(/([\d.]+)%/g)]
    .map((match) => Number(match[1]));

  const topologyFoot = [...document.querySelectorAll("#projectTopology tfoot td")].map((cell) => text(cell));

  return {
    hero: text(document.querySelector(".hero-number .value")),
    heroMeter: getComputedStyle(document.querySelector(".hero-number")).getPropertyValue("--meter").trim(),
    modelRows,
    modelCaption: text(document.querySelector(".model-pie-caption b")),
    ringEnd: ringStops.length ? ringStops[ringStops.length - 1] : null,
    machineRows: compositionRows("#spendMachines"),
    tokenRows: compositionRows("#tokenComposition"),
    // The last footer cell is the period total in dollars; the ones before it
    // are the model shares.
    topologyShares: topologyFoot.slice(0, -1),
    topologyTotal: topologyFoot[topologyFoot.length - 1] || "",
  };
})()
