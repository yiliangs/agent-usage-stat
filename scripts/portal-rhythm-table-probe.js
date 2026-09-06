/**
 * Runs inside the rendered portal and reports the session timeline's data
 * table as a reader sees it.
 *
 * The table is built from the same per-date segments the timeline draws with,
 * so what each column actually counts is decided in the renderer rather than
 * in any model a test can import. This reads the headers, every row, and the
 * caption stating how the two count columns are measured, and leaves the guard
 * to decide whether the columns add up.
 */
(async () => {
  // The table lives inside a collapsed <details>, which keeps it in the
  // document but not on screen. Waiting on the rows being written is what says
  // the timeline has rendered.
  await waitForRender(() => document.querySelectorAll("#rhythmTable tbody tr").length > 0);

  const text = (element) => (element ? element.textContent.trim() : null);

  return {
    headers: [...document.querySelectorAll("#rhythmTable thead th")].map((cell) => text(cell)),
    rows: [...document.querySelectorAll("#rhythmTable tbody tr")].map((row) => ({
      date: text(row.querySelector("th")),
      cells: [...row.querySelectorAll("td")].map((cell) => text(cell)),
    })),
    caption: text(document.querySelector("#rhythmTable .rhythm-table-note")),
  };
})()
