/**
 * Runs inside the rendered portal and reports numeric slots that overflow.
 *
 * The catalogue below is explicit rather than a scan of every text node: a
 * scan cannot tell a measurement that must hold one line from a sentence that
 * is meant to wrap, and that difference is the whole point. Add a row when a
 * panel gains a slot that displays a number.
 *
 * `line` slots carry a single value and have no room for a second line -- the
 * metric cards, for instance, reserve their lower band for the magnitude
 * meter, so a wrapped comparison lands on top of it. `flow` slots are notes
 * with the leading built in; they may wrap but must still not be cut off.
 * `trim` slots hold a name of unbounded length in a fixed row: one line is
 * required and an ellipsis is the designed ending, so their text is allowed
 * to run past the edge but never onto a second row.
 */
(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Right-aligned text sits flush against its container, and glyph bearings
   *  put the ink rectangle a hair past the edge. Below this nothing is lost. */
  const BEARING_TOLERANCE_PX = 2;

  const SLOTS = [
    ["overview", ".hero-number .value", "line", "API-equivalent value"],
    ["overview", ".hero-number .delta", "line", "hero period comparison"],
    ["overview", ".period-range strong", "line", "token volume"],
    ["overview", ".folio .index", "line", "session index"],
    ["overview", ".cadence-scale span", "line", "cadence range ends"],
    ["overview", ".metric b", "line", "metric value"],
    ["overview", ".metric small", "line", "metric comparison"],
    ["overview", ".model-pie-row", "line", "model share rows"],
    ["overview", ".heatmap-summary div b", "line", "heatmap summary value"],
    ["overview", ".project-row .name", "trim", "ranked project name"],
    ["overview", ".project-row .name small", "trim", "ranked project family"],
    ["overview", ".project-row .money", "line", "project spend"],
    ["overview", ".conc-row .name", "trim", "concentration project name"],
    ["overview", ".conc-row .share", "line", "concentration share"],
    ["overview", ".conc-row .value", "line", "concentration value"],
    ["overview", ".rhythm-stat dd", "line", "rhythm window stats"],
    ["overview", ".rhythm-event small", "line", "rhythm event rate"],
    ["overview", ".token-figure .big", "line", "cache figure"],
    ["overview", ".token-figure .unit", "flow", "cache figure unit"],
    ["spend", ".analysis-kpi b", "line", "spend KPI value"],
    ["spend", ".analysis-kpi small", "flow", "spend KPI note"],
    ["spend", ".analysis-bar-value", "line", "spend bar value"],
    ["tokens", ".analysis-kpi b", "line", "token KPI value"],
    ["tokens", ".analysis-kpi small", "flow", "token KPI note"],
    ["tokens", ".analysis-chart text", "line", "token chart axis"],
    ["tokens", "#tokenTrafficChart text", "line", "traffic chart axis"],
    ["projects", ".analysis-kpi b", "line", "project KPI value"],
    ["projects", ".analysis-kpi small", "flow", "project KPI note"],
    ["projects", ".topology-cell b", "line", "topology cell"],
    ["projects", ".topology-total", "line", "topology total"],
  ];

  /** The nearest ancestor that hides overflow. A scrollable ancestor stops the
   *  walk: content reachable by scrolling is presented, not lost. */
  function clipperOf(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "auto" || style.overflowX === "scroll") return null;
      if (style.overflowX === "hidden" || style.overflowX === "clip") return node;
    }
    return null;
  }

  /** Line boxes and lost pixels for one element's own text. Measuring the text
   *  rather than the box works for inline elements, whose clientWidth is 0. */
  function measure(element) {
    const rects = [];
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5));
    }
    if (!rects.length) return null;
    const lines = new Set(rects.map((rect) => Math.round(rect.top))).size;
    const clipper = clipperOf(element);
    let clippedPx = 0;
    if (clipper) {
      const box = clipper.getBoundingClientRect();
      const style = getComputedStyle(clipper);
      // Both edges: a chart label anchored to the plot's left edge is lost
      // just as completely as one that runs past its right edge.
      const lost = Math.max(
        Math.max(...rects.map((rect) => rect.right)) - (box.right - (parseFloat(style.paddingRight) || 0)),
        (box.left + (parseFloat(style.paddingLeft) || 0)) - Math.min(...rects.map((rect) => rect.left)),
      );
      if (lost > BEARING_TOLERANCE_PX) clippedPx = Math.round(lost);
    }
    return { lines, clippedPx };
  }

  const byView = new Map();
  for (const [view, selector, mode, label] of SLOTS) {
    if (!byView.has(view)) byView.set(view, []);
    byView.get(view).push([selector, mode, label]);
  }

  const findings = [];
  for (const [view, slots] of byView) {
    const tab = document.querySelector(`[data-portal-view="${view}"]`);
    if (tab) {
      tab.click();
      await settle(900);
    }
    const root = document.querySelector(`[data-view="${view}"]`);
    if (!root) continue;
    for (const [selector, mode, label] of slots) {
      for (const element of root.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const result = measure(element);
        if (!result) continue;
        const wrapped = mode !== "flow" && result.lines > 1;
        const clipped = mode === "trim" ? 0 : result.clippedPx;
        if (!wrapped && clipped === 0) continue;
        findings.push({
          view,
          label,
          selector,
          text: element.textContent.trim().slice(0, 60),
          lines: result.lines,
          clippedPx: clipped,
          reason: wrapped ? "wrap" : "clip",
        });
      }
    }
  }
  return { width: document.documentElement.clientWidth, findings };
})()
