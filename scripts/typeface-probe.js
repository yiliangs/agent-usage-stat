/**
 * Runs inside a rendered surface and reports designed faces it cannot supply.
 *
 * Reading the stylesheet cannot answer this. `--sans` names IBM Plex Sans
 * whether or not anything ships it, and on a workstation that happens to have
 * the face installed the page looks right while every other machine silently
 * takes the next entry in the fallback list. What matters is whether the
 * document carries the face, so the probe asks `document.fonts`, which knows
 * only about `@font-face` rules in the page and nothing about the operating
 * system's font book. That makes the answer the same on every machine.
 *
 * The weights are not listed here. Defaults on `b`, `strong`, and headings
 * demand weights no declaration names, so the demand is read off the drawn
 * document instead: every visible run of text reports the family and weight it
 * asked for, and the page then has to produce a loaded face for each pair.
 *
 * Both surfaces that declare the typography tokens run this: the packaged
 * renderer, which reaches its other views through the tab row, and the
 * first-run window, which has a single view and no tabs.
 */
(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Every view the portal's tab row can present. A face used only by the
   *  session table is still a face the application has to ship. */
  const VIEWS = ["overview", "spend", "tokens", "projects", "sessions", "settings"];

  /** The typography tokens, each a preference list whose first entry is the
   *  designed face and whose remainder is the fallback the defect exposes. */
  const TOKENS = ["--sans", "--text", "--mono", "--serif"];

  /**
   * The states a surface can present, each paired with the call that enters
   * it. A face is only demanded once something is drawn in it, so a surface
   * that holds most of its content behind a tab row or behind a runtime call
   * has to be walked rather than read once as loaded.
   *
   * Both lists go through the surface's own controls: the portal through its
   * tab row, the first-run window through the functions the main process
   * calls on it. Nothing here reaches past what the application itself uses.
   */
  function statesOf(document) {
    const tabs = VIEWS
      .map((view) => [view, document.querySelector(`[data-portal-view="${view}"]`)])
      .filter(([, tab]) => tab);
    if (tabs.length) {
      return tabs.map(([view, tab]) => [view, async () => {
        // The portal ships its views hidden and reveals them on first render,
        // so the first tab click only lands once something is on screen.
        await waitForRender(() => [...document.querySelectorAll(".portal-view")].some((v) => !v.hidden));
        tab.click();
        await settle(900);
      }]);
    }

    if (typeof window.agentUsageStatSteps !== "function") return [["document", async () => {}]];

    const plan = [
      { id: "helper", label: "Helper" },
      { id: "storage", label: "Storage" },
      { id: "sessions", label: "Sessions" },
    ];
    const question = {
      message: "Where should the usage ledger live?",
      facts: [{ label: "Folder", value: "C:\\Users\\example\\Agent Usage Stat" }],
      detail: ["Everything stays on this machine."],
      toggle: { label: "Keep checkpoints as sessions run", checked: true },
      options: [{ label: "Use this folder", value: "keep" }, { label: "Choose another", value: "pick" }],
    };
    return [
      ["loading", async () => { await settle(120); }],
      ["stepping", async () => {
        window.agentUsageStatSteps(plan);
        window.agentUsageStatStep("storage", "Choosing usage storage", "Select where the ledger is kept.");
        await settle(120);
      }],
      // The ask never settles here: nothing clicks an option, which is exactly
      // the state a person reads.
      ["asking", async () => {
        window.agentUsageStatAsk(question, "Local ledger", "Setup");
        await settle(120);
      }],
      ["failed", async () => {
        window.agentUsageStatFailed("The helper could not be installed.");
        await settle(120);
      }],
    ];
  }

  /** The first family in a CSS font-family list, unquoted. */
  function firstFamily(list) {
    const first = String(list || "").split(",")[0].trim();
    return first.replace(/^["']|["']$/g, "");
  }

  const rootStyle = getComputedStyle(document.documentElement);
  const designed = new Set(
    TOKENS.map((token) => firstFamily(rootStyle.getPropertyValue(token))).filter(Boolean),
  );

  /** True when the element draws text of its own rather than only wrapping
   *  children, which is what makes its resolved family and weight a demand. */
  function drawsOwnText(element) {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
    }
    return false;
  }

  const demand = new Map();
  function collect(view) {
    for (const element of document.querySelectorAll("*")) {
      if (!drawsOwnText(element)) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const family = firstFamily(style.fontFamily);
      if (!designed.has(family)) continue;
      const weight = String(parseInt(style.fontWeight, 10) || 400);
      const key = `${family}|${weight}`;
      if (demand.has(key)) continue;
      demand.set(key, { family, weight, view, sample: element.textContent.trim().slice(0, 40) });
    }
  }

  for (const [state, enter] of statesOf(document)) {
    await enter();
    collect(state);
  }

  // `document.fonts.load` resolves against the document's own `@font-face`
  // rules and returns an empty list when none matches, so a face the machine
  // merely has installed never counts as one the application ships.
  const missing = [];
  for (const entry of demand.values()) {
    let faces = [];
    try {
      faces = await document.fonts.load(`${entry.weight} 16px "${entry.family}"`);
    } catch {
      faces = [];
    }
    if (faces.some((face) => face.status === "loaded")) continue;
    missing.push({ ...entry, matched: faces.length });
  }

  return {
    designed: [...designed].sort(),
    demanded: [...demand.keys()].sort(),
    missing,
  };
})()
