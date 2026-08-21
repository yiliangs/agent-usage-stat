/**
 * Runs inside the rendered portal and reports what each session block on the
 * timeline actually shows.
 *
 * A block's label is suppressed by container queries against its own box, so
 * whether a name is on screen is a fact of the rendered geometry and cannot be
 * read off the markup. This reports the drawn box and the drawn text for every
 * block, and leaves the guard to decide which of them owed the reader a name.
 */
(async () => {
  // Blocks are drawn by the first render, so one on the page means the
  // geometry this probe measures exists to be measured.
  await waitForRender(() => document.querySelectorAll(".rhythm-event").length > 0);

  /** The text a reader can actually see in this element, ignoring anything a
   *  rule has taken out of the flow. */
  function visibleText(element) {
    if (!element) return "";
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return "";
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return "";
    return element.textContent.trim();
  }

  const blocks = [...document.querySelectorAll(".rhythm-event")].map((event) => {
    const box = event.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      name: visibleText(event.querySelector("span")),
      rate: visibleText(event.querySelector("small")),
      tip: event.dataset.tip || "",
    };
  });

  return { width: document.documentElement.clientWidth, blocks };
})()
