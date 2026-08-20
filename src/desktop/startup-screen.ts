import type { BrowserWindow } from "electron";

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
      --graphite: #686761;
      --track: #c8c4ba;
      --signal: #ba5d37;
      --teal: #00897d;
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      display: grid;
      grid-template-columns: minmax(360px, 42%) 1fr;
      overflow: hidden;
      background: var(--paper);
      color: var(--ink);
      font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
    }
    .signal-field {
      position: relative;
      display: flex;
      align-items: flex-end;
      min-height: 100%;
      overflow: hidden;
      padding: 10vh 8vw 9vh 7vw;
      background: linear-gradient(145deg, #292a26 0%, #151614 76%);
    }
    .signal-field::before {
      content: "";
      position: absolute;
      inset: 0;
      opacity: .13;
      background-image:
        linear-gradient(rgba(243,240,231,.4) 1px, transparent 1px),
        linear-gradient(90deg, rgba(243,240,231,.4) 1px, transparent 1px);
      background-size: 72px 72px;
    }
    .bars {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: flex-end;
      gap: clamp(18px, 2.2vw, 34px);
      width: min(440px, 100%);
      height: 48vh;
      border-bottom: 5px solid var(--teal);
    }
    .bar {
      width: clamp(24px, 3vw, 46px);
      min-height: 56px;
      border-radius: 99px 99px 0 0;
      background: var(--paper);
      transform-origin: bottom;
      animation: ledger 1.8s cubic-bezier(.65,0,.35,1) infinite;
    }
    .bar:nth-child(1) { height: 34%; animation-delay: -.9s; }
    .bar:nth-child(2) { height: 62%; animation-delay: -.7s; }
    .bar:nth-child(3) { height: 46%; animation-delay: -.5s; }
    .bar:nth-child(4) { height: 82%; animation-delay: -.3s; }
    .bar:nth-child(5) { height: 58%; animation-delay: -.1s; }
    .trend {
      position: absolute;
      left: 0;
      bottom: 28%;
      width: 100%;
      height: 7px;
      overflow: hidden;
      transform: rotate(-7deg);
      background: rgba(186,93,55,.28);
    }
    .trend::after {
      content: "";
      display: block;
      width: 42%;
      height: 100%;
      background: var(--signal);
      animation: scan 1.8s ease-in-out infinite;
    }
    main {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      padding: 10vh clamp(54px, 8vw, 132px);
      background:
        linear-gradient(90deg, rgba(23,24,23,.08) 1px, transparent 1px) 0 0 / 88px 100%,
        var(--paper);
    }
    .eyebrow {
      margin: 0 0 24px;
      color: var(--signal);
      font: 700 12px/1.3 "Cascadia Mono", Consolas, monospace;
      letter-spacing: .19em;
      text-transform: uppercase;
    }
    h1 {
      max-width: 690px;
      margin: 0;
      font-size: clamp(42px, 5.3vw, 78px);
      font-weight: 560;
      letter-spacing: -.045em;
      line-height: .99;
    }
    .status {
      max-width: 620px;
      min-height: 3.4em;
      margin: 34px 0 0;
      color: var(--graphite);
      font-size: clamp(16px, 1.5vw, 21px);
      line-height: 1.55;
    }
    .progress {
      position: relative;
      width: min(560px, 100%);
      height: 2px;
      margin-top: 42px;
      overflow: hidden;
      background: var(--track);
    }
    .progress::after {
      content: "";
      position: absolute;
      inset: 0 auto 0 -35%;
      width: 35%;
      background: var(--signal);
      animation: progress 1.45s cubic-bezier(.4,0,.2,1) infinite;
    }
    .providers {
      margin-top: 20px;
      color: var(--graphite);
      font: 600 11px/1.4 "Cascadia Mono", Consolas, monospace;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    body.failed .bar, body.failed .trend::after, body.failed .progress::after { animation: none; }
    body.failed .progress::after { left: 0; width: 100%; }
    body.failed .eyebrow, body.failed .progress::after { color: #9b382d; background: #9b382d; }
    @keyframes ledger { 0%, 100% { transform: scaleY(.72); opacity: .72; } 50% { transform: scaleY(1); opacity: 1; } }
    @keyframes scan { from { transform: translateX(-110%); } to { transform: translateX(240%); } }
    @keyframes progress { from { transform: translateX(0); } to { transform: translateX(390%); } }
    @media (prefers-reduced-motion: reduce) {
      .bar, .trend::after, .progress::after { animation: none; }
      .progress::after { left: 0; width: 38%; }
    }
    @media (max-width: 840px) {
      body { grid-template-columns: 30% 1fr; }
      .signal-field { padding-inline: 5vw; }
      .bars { gap: 12px; }
      main { padding-inline: 48px; }
    }
  </style>
</head>
<body>
  <section class="signal-field" aria-hidden="true">
    <div class="bars">
      <i class="bar"></i><i class="bar"></i><i class="bar"></i><i class="bar"></i><i class="bar"></i>
      <span class="trend"></span>
    </div>
  </section>
  <main>
    <p class="eyebrow" id="eyebrow">Local ledger · starting</p>
    <h1 id="headline">Preparing your usage workspace</h1>
    <p class="status" id="status">Connecting the local helper and reconciling recent agent sessions. Your data stays on this machine.</p>
    <div class="progress" role="progressbar" aria-label="Starting Agent Usage Stat"></div>
    <p class="providers">Claude Code / Codex / Copilot CLI / opencode</p>
  </main>
  <script>
    window.agentUsageStatStartup = (headline, detail, failed) => {
      document.getElementById('headline').textContent = headline;
      document.getElementById('status').textContent = detail;
      if (failed) {
        document.body.classList.add('failed');
        document.getElementById('eyebrow').textContent = 'Startup interrupted';
      }
    };
  </script>
</body>
</html>`;

export const STARTUP_URL = `data:text/html;charset=UTF-8,${encodeURIComponent(STARTUP_HTML)}`;

export async function updateStartupScreen(
  window: BrowserWindow,
  headline: string,
  detail: string,
  failed = false,
): Promise<void> {
  if (window.isDestroyed()) return;
  await window.webContents.executeJavaScript(
    `window.agentUsageStatStartup?.(${JSON.stringify(headline)}, ${JSON.stringify(detail)}, ${failed})`,
  );
}
