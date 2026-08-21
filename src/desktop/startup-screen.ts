import type { BrowserWindow } from "electron";
import type {
  SetupAnswer,
  SetupNotice,
  SetupQuestion,
} from "./setup-question.js";

/**
 * The first run is a fixed sequence, so the screen owns it. The spine, the
 * headline, and the prose all read from this one list rather than from copy
 * repeated at each call site in the lifecycle.
 */
export const FIRST_RUN_STEPS = [
  {
    id: "helper",
    label: "Helper",
    headline: "Connecting the local helper",
    detail:
      "Preparing the local process that imports agent sessions into your " +
      "usage ledger.",
  },
  {
    id: "storage",
    label: "Storage",
    headline: "Choosing usage storage",
    detail: "Select where the durable usage ledger should be kept.",
  },
  {
    id: "capture",
    label: "Capture",
    headline: "Choosing capture behavior",
    detail: "Choose between continuous checkpoints and batch synchronization.",
  },
  {
    id: "agents",
    label: "Agents",
    headline: "Checking agent connections",
    detail:
      "Applying your capture choice to Claude Code, Codex, Copilot CLI, and " +
      "opencode.",
  },
  {
    id: "sessions",
    label: "Sessions",
    headline: "Reconciling recent sessions",
    detail: "Building the local dashboard from your usage ledger.",
  },
] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]["id"];

const STARTUP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Agent Usage Stat</title>
  <style>
    :root {
      color-scheme: light;
      --field: #dfddd6;
      --paper: #f3f0e7;
      --paper-hi: #faf8f2;
      --ink: #171817;
      --ink-rgb: 23, 24, 23;
      --graphite: #686761;
      --muted: #9a9890;
      --line: #cac6bc;
      --line-dark: #9f9c93;
      --accent: #ba5d37;
      --status-error: #a3483a;
      --sans: "IBM Plex Sans", Aptos, "Segoe UI", sans-serif;
      --mono: "Geist Mono", "Cascadia Mono", Consolas, monospace;
      --serif: "Libre Baskerville", Georgia, serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --field: #171713;
        --paper: #201f1a;
        --paper-hi: #29271f;
        --ink: #eee9db;
        --ink-rgb: 238, 233, 219;
        --graphite: #c3bcab;
        --muted: #918a7b;
        --line: #454239;
        --line-dark: #6a6558;
        --accent: #d77a50;
        --status-error: #dc7866;
      }
    }
    * { box-sizing: border-box; }
    /* The question slots carry their own display mode, which would otherwise
       outrank the user agent rule for [hidden] and leave empty frames behind. */
    [hidden] { display: none !important; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
      background:
        linear-gradient(90deg, rgba(var(--ink-rgb), .018) 1px, transparent 1px) 0 0 / 88px 100%,
        var(--field);
      color: var(--ink);
      font-family: var(--sans);
      -webkit-font-smoothing: antialiased;
    }

    .frame-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      height: 54px;
      padding: 0 clamp(24px, 3vw, 40px);
      border-bottom: 1px solid var(--ink);
      background: var(--paper);
    }
    .wordmark {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .18em;
      text-transform: uppercase;
    }
    .frame-tag {
      color: var(--graphite);
      font-family: var(--mono);
      font-size: 9px;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    body.asking .frame-tag { color: var(--accent); }
    body.failed .frame-tag { color: var(--status-error); }

    .frame-body {
      /* One offset for both columns. The headline sits at the same height on
         every step, so nothing jumps as the material below it changes. */
      --crown: clamp(40px, 12vh, 104px);
      display: grid;
      grid-template-columns: minmax(220px, 25%) minmax(0, 1fr);
      min-height: 0;
    }

    .spine {
      overflow-y: auto;
      padding: var(--crown) clamp(20px, 2.4vw, 34px);
      border-right: 1px solid var(--ink);
      background: var(--paper-hi);
    }
    .spine h2 {
      margin: 0 0 16px 12px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 8.5px;
      font-weight: 600;
      letter-spacing: .19em;
      text-transform: uppercase;
    }
    .spine ol {
      display: grid;
      gap: 2px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .step {
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr) 10px;
      align-items: center;
      gap: 12px;
      padding: 11px 12px;
      border: 1px solid transparent;
      color: var(--muted);
      transition: color .18s, background .18s, border-color .18s;
    }
    .step-index {
      font-family: var(--mono);
      font-size: 9.5px;
      letter-spacing: .06em;
    }
    .step-label {
      overflow: hidden;
      font-size: 12.5px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .step-dot {
      width: 7px;
      height: 7px;
      border: 1px solid currentColor;
      border-radius: 50%;
    }
    .step[data-state="done"] { color: var(--graphite); }
    .step[data-state="done"] .step-dot { background: currentColor; }
    .step[data-state="active"] {
      border-color: var(--ink);
      background: var(--paper);
      color: var(--ink);
    }
    .step[data-state="active"] .step-dot {
      border-color: var(--accent);
      background: var(--accent);
      animation: pulse 1.5s ease-in-out infinite;
    }
    body.failed .step[data-state="active"] { border-color: var(--status-error); }
    body.failed .step[data-state="active"] .step-dot {
      border-color: var(--status-error);
      background: var(--status-error);
      animation: none;
    }

    .sheet {
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow-y: auto;
      padding: var(--crown) clamp(34px, 5.4vw, 92px) clamp(28px, 5vh, 60px);
      background: var(--paper);
    }
    .eyebrow {
      margin: 0 0 18px;
      color: var(--accent);
      font-family: var(--mono);
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: .19em;
      text-transform: uppercase;
    }
    body.failed .eyebrow { color: var(--status-error); }
    h1 {
      max-width: 17ch;
      margin: 0;
      font-family: var(--serif);
      font-size: clamp(30px, 3.5vw, 50px);
      font-weight: 400;
      letter-spacing: -.02em;
      line-height: 1.1;
    }
    .lede {
      max-width: 58ch;
      margin: 22px 0 0;
      color: var(--graphite);
      font-size: 14.5px;
      line-height: 1.62;
    }

    .facts {
      display: grid;
      max-width: 62ch;
      margin: 26px 0 0;
      padding: 16px 18px;
      border: 1px solid var(--line);
      background: rgba(var(--ink-rgb), .022);
    }
    .facts dt {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 8.5px;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    .facts dd {
      margin: 5px 0 0;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .facts dd + dt { margin-top: 14px; }

    .notes { max-width: 58ch; margin-top: 22px; }
    .notes p {
      margin: 0 0 12px;
      color: var(--graphite);
      font-size: 13.5px;
      line-height: 1.6;
    }
    .notes p:last-child { margin-bottom: 0; }

    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin-top: 20px;
      font-size: 13px;
      cursor: pointer;
    }
    .toggle input {
      width: 15px;
      height: 15px;
      margin: 0;
      accent-color: var(--accent);
    }

    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 30px; }
    .action {
      padding: 11px 21px;
      border: 1px solid var(--line-dark);
      background: transparent;
      color: var(--ink);
      font-family: var(--sans);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background .14s, border-color .14s, color .14s;
    }
    .action:hover { border-color: var(--ink); background: rgba(var(--ink-rgb), .06); }
    .action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .action.primary { border-color: var(--ink); background: var(--ink); color: var(--paper-hi); }
    .action.primary:hover { background: rgba(var(--ink-rgb), .84); }

    .meter {
      position: relative;
      width: min(520px, 100%);
      height: 2px;
      margin-top: 34px;
      overflow: hidden;
      background: var(--line);
    }
    .meter i {
      position: absolute;
      inset: 0 auto 0 0;
      width: 34%;
      background: var(--accent);
      animation: sweep 1.45s cubic-bezier(.4, 0, .2, 1) infinite;
    }
    body.asking .meter { visibility: hidden; }
    body.failed .meter i { width: 100%; background: var(--status-error); animation: none; }

    .providers {
      margin: 20px 0 0;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 8.5px;
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    @keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(294%); } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
    @media (prefers-reduced-motion: reduce) {
      .meter i { width: 38%; animation: none; }
      .step[data-state="active"] .step-dot { animation: none; }
    }
    /* The shortest window the shell allows is 700px tall. Tighten the type
       and the gaps there so a question still resolves without scrolling. */
    @media (max-height: 820px) {
      h1 { font-size: clamp(27px, 3vw, 36px); }
      .lede { margin-top: 16px; }
      .facts { margin-top: 20px; padding: 13px 15px; }
      .notes { margin-top: 18px; }
      .actions { margin-top: 22px; }
      .meter { margin-top: 24px; }
      .step { padding: 8px 12px; }
    }
    @media (max-width: 900px) {
      .frame-body { grid-template-columns: minmax(0, 1fr); }
      .spine { display: none; }
    }
  </style>
</head>
<body>
  <header class="frame-head">
    <span class="wordmark">Agent Usage Stat</span>
    <span class="frame-tag" id="frameTag">First run</span>
  </header>
  <div class="frame-body">
    <nav class="spine" aria-label="Setup progress">
      <h2>Setup</h2>
      <ol id="steps"></ol>
    </nav>
    <main class="sheet">
      <p class="eyebrow" id="eyebrow">Local ledger</p>
      <h1 id="headline">Preparing your usage workspace</h1>
      <p class="lede" id="lede">Connecting the local helper and reconciling recent agent sessions. Your data stays on this machine.</p>
      <dl class="facts" id="facts" hidden></dl>
      <div class="notes" id="notes" hidden></div>
      <label class="toggle" id="toggle" hidden>
        <input type="checkbox" id="toggleInput">
        <span id="toggleLabel"></span>
      </label>
      <div class="actions" id="actions" hidden></div>
      <div class="meter" id="meter" role="progressbar" aria-label="Starting Agent Usage Stat"><i></i></div>
      <p class="providers">Claude Code / Codex / Copilot CLI / opencode</p>
    </main>
  </div>
  <script>
    const ui = new Proxy({}, { get: (_, id) => document.getElementById(id) });
    let steps = [];
    let activeStep = -1;

    const paintSpine = () => {
      ui.steps.replaceChildren(...steps.map((step, index) => {
        const item = document.createElement('li');
        item.className = 'step';
        item.dataset.state = index < activeStep
          ? 'done'
          : index === activeStep ? 'active' : 'pending';
        if (index === activeStep) item.setAttribute('aria-current', 'step');
        const order = document.createElement('span');
        order.className = 'step-index';
        order.textContent = String(index + 1).padStart(2, '0');
        const label = document.createElement('span');
        label.className = 'step-label';
        label.textContent = step.label;
        const dot = document.createElement('span');
        dot.className = 'step-dot';
        item.append(order, label, dot);
        return item;
      }));
    };

    const clearQuestion = () => {
      ui.facts.hidden = true;
      ui.notes.hidden = true;
      ui.toggle.hidden = true;
      ui.actions.hidden = true;
      document.body.classList.remove('asking');
      ui.frameTag.textContent = document.body.classList.contains('failed')
        ? 'Interrupted'
        : 'First run';
    };

    window.agentUsageStatSteps = (plan) => {
      steps = plan;
      paintSpine();
    };

    window.agentUsageStatStep = (id, headline, detail) => {
      clearQuestion();
      const index = steps.findIndex((step) => step.id === id);
      if (index >= 0) activeStep = index;
      paintSpine();
      ui.eyebrow.textContent = 'Local ledger';
      ui.headline.textContent = headline;
      ui.lede.textContent = detail;
      ui.lede.hidden = false;
    };

    window.agentUsageStatFailed = (detail) => {
      clearQuestion();
      document.body.classList.add('failed');
      ui.frameTag.textContent = 'Interrupted';
      ui.eyebrow.textContent = 'Startup interrupted';
      ui.headline.textContent = 'The workspace could not start';
      ui.lede.textContent = detail;
      ui.lede.hidden = false;
    };

    window.agentUsageStatAsk = (question, eyebrow, tag) => new Promise((settle) => {
      ui.eyebrow.textContent = eyebrow;
      ui.frameTag.textContent = tag;
      ui.headline.textContent = question.message;
      ui.lede.hidden = true;

      ui.facts.replaceChildren(...question.facts.flatMap((fact) => {
        const term = document.createElement('dt');
        term.textContent = fact.label;
        const value = document.createElement('dd');
        value.textContent = fact.value;
        return [term, value];
      }));
      ui.facts.hidden = question.facts.length === 0;

      ui.notes.replaceChildren(...question.detail.map((text) => {
        const note = document.createElement('p');
        note.textContent = text;
        return note;
      }));
      ui.notes.hidden = question.detail.length === 0;

      ui.toggle.hidden = !question.toggle;
      ui.toggleInput.checked = Boolean(question.toggle && question.toggle.checked);
      ui.toggleLabel.textContent = question.toggle ? question.toggle.label : '';

      ui.actions.replaceChildren(...question.options.map((option, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = index === 0 ? 'action primary' : 'action';
        button.textContent = option.label;
        button.addEventListener('click', () => {
          const toggled = ui.toggleInput.checked;
          clearQuestion();
          settle({ value: option.value, toggled });
        });
        return button;
      }));
      ui.actions.hidden = false;

      document.body.classList.add('asking');
      ui.actions.firstElementChild.focus();
    });
  </script>
</body>
</html>`;

export const STARTUP_URL = `data:text/html;charset=UTF-8,${encodeURIComponent(STARTUP_HTML)}`;

/** Draws the setup spine once the window is live. */
export async function installStartupSteps(window: BrowserWindow): Promise<void> {
  const plan = FIRST_RUN_STEPS.map(({ id, label }) => ({ id, label }));
  await evaluate(window, `window.agentUsageStatSteps(${JSON.stringify(plan)})`);
}

/** Advances the spine and repaints the sheet with that step's own copy. */
export async function enterStartupStep(
  window: BrowserWindow,
  id: FirstRunStep,
): Promise<void> {
  const step = FIRST_RUN_STEPS.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Unknown first-run step: ${id}`);
  await evaluate(
    window,
    `window.agentUsageStatStep(${JSON.stringify(id)}, ` +
      `${JSON.stringify(step.headline)}, ${JSON.stringify(step.detail)})`,
  );
}

export async function failStartupScreen(
  window: BrowserWindow,
  detail: string,
): Promise<void> {
  await evaluate(window, `window.agentUsageStatFailed(${JSON.stringify(detail)})`);
}

/** Asks a setup question inside the window instead of over it. */
export function askOnStartupScreen<Value extends string>(
  window: BrowserWindow,
  question: SetupQuestion<Value>,
): Promise<SetupAnswer<Value>> {
  return ask(window, question, "Local ledger · your choice");
}

/** A one-way message, drawn as a question with a single acknowledgment. */
export async function noticeOnStartupScreen(
  window: BrowserWindow,
  notice: SetupNotice,
): Promise<void> {
  await ask(window, {
    message: notice.message,
    facts: [],
    detail: [notice.detail],
    options: [{ value: "acknowledged", label: "Continue" }],
  }, notice.title);
}

function ask<Value extends string>(
  window: BrowserWindow,
  question: SetupQuestion<Value>,
  eyebrow: string,
): Promise<SetupAnswer<Value>> {
  return window.webContents.executeJavaScript(
    `window.agentUsageStatAsk(${JSON.stringify(question)}, ` +
      `${JSON.stringify(eyebrow)}, "Needs your input")`,
  );
}

async function evaluate(window: BrowserWindow, code: string): Promise<void> {
  if (window.isDestroyed()) return;
  await window.webContents.executeJavaScript(code);
}
