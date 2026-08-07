# Agent Usage Stat

A private desktop application for understanding how Claude Code, OpenAI Codex, and GitHub Copilot CLI use tokens, time, and API-equivalent cost.

![Agent Usage Stat](screenshot.png)

## Supported

- Windows and macOS
- Claude Code
- OpenAI Codex, including Codex sessions used through ChatGPT
- GitHub Copilot CLI

Agent Usage Stat does not read general ChatGPT or Claude.ai chats. All usage data stays on the local machine or in the folder already selected by the user.

## Install

Download the current installer from [GitHub Releases](https://github.com/yiliangs/agent-usage-stat/releases):

- Windows: `Agent-Usage-Stat-Setup.exe`
- macOS: `Agent-Usage-Stat.dmg`

No separate Node.js or npm installation is required.

On first launch, Agent Usage Stat detects installed agents, preserves an existing v2 data location when present, installs its capture hooks, reconciles existing sessions, and opens the desktop dashboard. New installations use `~/.agent-usage-stat/data` unless an existing shared usage root is detected.

Codex requires one security confirmation after its hook is first installed. Open `/hooks` in Codex and trust the Agent Usage Stat hook when prompted.

Closing the desktop window does not disable capture. A small bundled helper records completed sessions without opening the application.

## What it shows

- Spend and token trends
- Claude Code, Codex, and Copilot comparisons
- Model-vendor, project, machine, and session breakdowns
- Cache read and write efficiency
- Searchable session details
- Weekly and monthly session timelines

Costs are API-equivalent list-price estimates. They are not charges added to a ChatGPT, Claude, or Copilot subscription.

Each completed session becomes one JSON file under `<data-root>/logbook.d/`. A synced data folder can combine several Windows and macOS machines.

## Application architecture

```text
Claude / Codex / Copilot hooks
  -> installed standalone helper
  -> provider-specific transcript parser and pricing
  -> logbook.d/<session-id>.json

Agent Usage Stat desktop application
  -> Electron main process
  -> aus:// packaged renderer
  -> generated local analytics snapshot
```

The production application opens no localhost server. The renderer is sandboxed and reads packaged assets and generated data through the application protocol.

## Development

Node.js 20 or newer is required for development only.

```bash
npm install
npm install --prefix portal
npm test
npm run test:desktop
npm start
npm run make
```

- `npm test` runs the core and portal regression suite.
- `npm run test:desktop` packages the application and exercises the standalone helper, first-run hook installation, custom protocol, refresh, and renderer.
- `npm start` builds and launches the development desktop application.
- `npm run make` creates platform installers under `out/desktop/make/`.

Tagged releases are built for Windows and macOS by `.github/workflows/desktop-release.yml`. The workflow requires signing credentials before it will publish anything:

- Windows: `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`
- macOS: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`

Local `npm run make` artifacts are unsigned development builds. Published releases are signed, and macOS releases are notarized. The root npm project is private and exposes no supported JavaScript library API or end-user CLI package.

Licensed under MIT.
