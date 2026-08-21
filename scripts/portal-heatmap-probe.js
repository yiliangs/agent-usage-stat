/**
 * Runs inside the rendered portal and reports what clicking each heatmap day
 * cell actually opens.
 *
 * Whether a mark is interactive is a fact of the rendered page: the cell is a
 * button with a pointer cursor whatever the source says, so only a real click
 * answers it. This clicks every day that recorded work, plus the first day
 * that recorded none, and reports the detail drawer that came up, leaving the
 * guard to decide which days owed the reader one.
 *
 * Days are identified by the leading date in the cell's accessible name, which
 * is what a reader is told the cell stands for.
 */
(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await settle(1200);

  const text = (element) => (element ? element.textContent.trim() : "");
  const scrim = document.querySelector("#detailScrim");

  /** The drawer as a reader sees it, or null when nothing opened. */
  function openedDrawer() {
    if (!scrim || scrim.hidden) return null;
    return {
      eyebrow: text(document.querySelector("#detailEyebrow")),
      title: text(document.querySelector("#detailTitle")),
      stats: [...document.querySelectorAll("#detailBody .detail-stat")].map((stat) => ({
        label: text(stat.querySelector("span")),
        value: text(stat.querySelector("b")),
      })),
      sections: [...document.querySelectorAll("#detailBody .detail-section")].map((section) => ({
        title: text(section.querySelector("h3")),
        rows: [...section.querySelectorAll(".detail-list div")].map((row) => ({
          label: text(row.querySelector("span")),
          value: text(row.querySelector("b")),
        })),
        text: text(section.querySelector("p")),
      })),
    };
  }

  function close() {
    const button = document.querySelector("#detailClose");
    if (button) button.click();
  }

  const cells = [...document.querySelectorAll(".calendar-cell")].map((cell) => {
    const label = cell.getAttribute("aria-label") || "";
    const match = /^(.*?):.*?, (\d+) sessions?,/.exec(label);
    return { cell, label, day: match ? match[1] : "", sessions: match ? Number(match[2]) : 0 };
  });

  // Every day that recorded work, plus the quiet days sitting right beside
  // one. A field of 365 cells is mostly empty, and a quiet day next to a busy
  // one is the cell a reader misses by.
  const clicked = cells.filter((entry, index) =>
    entry.day &&
    (entry.sessions > 0 || cells[index - 1]?.sessions > 0 || cells[index + 1]?.sessions > 0));

  const days = [];
  for (const entry of clicked) {
    close();
    entry.cell.click();
    days.push({ day: entry.day, sessions: entry.sessions, drawer: openedDrawer() });
    close();
  }

  return {
    cellCount: cells.length,
    heatmapVisible: !document.querySelector(".spend-heatmap-view").hidden,
    days,
  };
})()
