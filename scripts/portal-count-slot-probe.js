/**
 * Runs inside the rendered portal and reports which of the strings a count
 * formatter can produce do not fit the slot that holds them.
 *
 * The layout probe measures the numbers a fixture happens to produce, which is
 * the right check for a panel but the wrong one for a ceiling: no fixture a
 * browser can render carries a million sessions, so the widest string a count
 * format emits is never on screen (#94). This probe writes each candidate into
 * the real slot instead, in the real page, and measures what the renderer does
 * with it. The candidates come from `probeInput`, computed in Node from the
 * formatters themselves, so the guard tracks the formats rather than restating
 * their output.
 */
(async () => {
  await waitForRender(() => [...document.querySelectorAll(".portal-view")].some((view) => !view.hidden));

  /** Right-aligned text sits flush against its container, and glyph bearings
   *  put the ink rectangle a hair past the edge. Below this nothing is lost. */
  const BEARING_TOLERANCE_PX = 2;

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

  /** Line boxes and lost pixels for one element's own text. */
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
      const lost = Math.max(
        Math.max(...rects.map((rect) => rect.right)) - (box.right - (parseFloat(style.paddingRight) || 0)),
        (box.left + (parseFloat(style.paddingLeft) || 0)) - Math.min(...rects.map((rect) => rect.left)),
      );
      if (lost > BEARING_TOLERANCE_PX) clippedPx = Math.round(lost);
    }
    return { lines, clippedPx };
  }

  const findings = [];
  for (const { selector, label, neighbours = [], texts } of probeInput.cases) {
    const element = document.querySelector(selector);
    if (!element) {
      findings.push({ label, selector, text: "", reason: "missing", lines: 0, clippedPx: 0 });
      continue;
    }
    // A slot that shares a shrinking row with a label breaks the row, not just
    // itself: the label wraps at the same length the value does, so both are
    // measured and either one is the finding.
    const companions = neighbours.map((neighbour) => document.querySelector(neighbour)).filter(Boolean);
    const original = element.textContent;
    for (const text of texts) {
      element.textContent = text;
      // Reading a geometry property is what forces the layout back out.
      void element.getBoundingClientRect();
      for (const [subject, node] of [[selector, element], ...companions.map((node, at) => [neighbours[at], node])]) {
        const result = measure(node);
        if (!result) continue;
        if (result.lines <= 1 && result.clippedPx === 0) continue;
        findings.push({
          label,
          selector: subject,
          text,
          lines: result.lines,
          clippedPx: result.clippedPx,
          reason: result.lines > 1 ? "wrap" : "clip",
        });
      }
    }
    element.textContent = original;
  }
  return { width: document.documentElement.clientWidth, findings };
})()
