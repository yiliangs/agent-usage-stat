/**
 * Runs inside the rendered portal and reports what the page states about the
 * ledger behind it, in the places a reader takes on trust.
 *
 * The header's machine field, the topology table's Value column, the refresh
 * button, and the session-timeline description are all facts of the rendered
 * page rather than of the source: whether a total matches the column above it,
 * whether a control moves when it is clicked, and whether a sentence fits on
 * one line are all questions only the renderer answers. This drives the real
 * page and reports what it drew, leaving the guard to decide what was owed.
 *
 * `probeInput.machineSlot` carries strings the machine field's formatter can
 * emit, which are computed in Node and written into the real slot here, the
 * way `portal-count-slot-probe.js` grounds a budget no fixture can reach.
 */
(async () => {
  await waitForRender(() => [...document.querySelectorAll(".portal-view")].some((view) => !view.hidden));

  /** Right-aligned text sits flush against its container, and glyph bearings
   *  put the ink rectangle a hair past the edge. Below this nothing is lost. */
  const BEARING_TOLERANCE_PX = 2;

  const text = (element) => (element ? element.textContent.trim() : null);

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
    if (!element) return null;
    const rects = [];
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5));
    }
    if (!rects.length) return { lines: 0, clippedPx: 0 };
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

  /** Write each candidate into a real slot and report what the renderer did
   *  with it, then put the page back the way it was found. */
  function fillSlot(selector, texts) {
    const element = document.querySelector(selector);
    if (!element) return texts.map((value) => ({ text: value, lines: 0, clippedPx: 0, missing: true }));
    const original = element.textContent;
    const results = texts.map((value) => {
      element.textContent = value;
      // Reading a geometry property is what forces the layout back out.
      void element.getBoundingClientRect();
      return { text: value, ...measure(element) };
    });
    element.textContent = original;
    return results;
  }

  const machineValue = document.querySelector(".top-meta b");
  const header = {
    machine: text(machineValue),
    label: text(document.querySelector(".top-meta div:first-child .micro")),
    ...measure(machineValue),
  };

  return {
    header,
    machineSlot: fillSlot(".top-meta b", probeInput?.machineSlot || []),
  };
})()
