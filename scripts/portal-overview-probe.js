/**
 * Runs inside the rendered portal and reports the figures the overview hero
 * prints for the selected period.
 *
 * What the hero says is a fact of the rendered page rather than of the source
 * line that writes it. Reading the line instead passes when it sits in a
 * function nothing calls and fails on a change of quote style, so the guard
 * that owns this reads the page the renderer drew.
 *
 * The token volume is read twice, from the hero and from the Tokens metric
 * beside it, because both stand for the same quantity and a reader comparing
 * them expects one answer.
 */
(async () => {
  // index.html ships every view hidden and portal.js reveals the selected one
  // at the end of its first render, so a visible view is a render that ran all
  // the way through the hero rather than a page still holding its markup.
  await waitForRender(() =>
    [...document.querySelectorAll(".portal-view")].some((view) => !view.hidden));

  const text = (element) => (element ? element.textContent.trim() : null);

  /** The value in the metric card carrying `label`, as the reader sees it. */
  function metric(label) {
    const found = [...document.querySelectorAll(".metric")]
      .find((entry) => text(entry.querySelector(".micro")) === label);
    return found ? text(found.querySelector("b")) : null;
  }

  return {
    range: text(document.querySelector(".ranges .chip.active")),
    tokenHero: text(document.querySelector(".period-range strong")),
    tokensMetric: metric("Tokens"),
  };
})()
