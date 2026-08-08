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
- Windows portable: `Agent Usage Stat-win32-x64-*.zip`
- macOS: `Agent-Usage-Stat.dmg`

No separate Node.js or npm installation is required.

The Windows installer shows installation activity, creates Start menu and desktop shortcuts, and opens the application when installation completes. On first launch, Agent Usage Stat asks where to keep the durable usage ledger and how sessions should be captured, then reconciles existing sessions and opens the desktop dashboard. The recommended local ledger is `%LOCALAPPDATA%\Agent Usage Stat\ledger` on Windows and `~/Library/Application Support/Agent Usage Stat/ledger` on macOS. Existing configured or shared ledgers are offered when found.

To combine usage from multiple computers, choose a folder in Google Drive, OneDrive, Dropbox, or another synchronized drive, then select the corresponding synchronized folder on each computer. The ledger contains usage totals, model names, project names, branches, and local project paths. It does not contain prompt or response text. Parsing and dashboard caches remain local and disposable.

Automatic capture is recommended and installs hooks for detected agents so completed sessions reach the ledger while the application is closed. Codex requires one security confirmation after its hook is first installed. Open `/hooks` in Codex and trust the Agent Usage Stat hook when prompted.

Import-on-open mode installs no Agent Usage Stat hooks. It reconciles discoverable local transcripts whenever the application opens or refreshes, but cannot recover a session deleted by an agent before the next import. The capture mode can be changed later from the application menu.

When automatic capture is active, closing the desktop window does not disable capture. A small bundled helper records completed sessions without opening the application.

## What it shows

- Spend and token trends
- Claude Code, Codex, and Copilot comparisons
- Model-vendor, project, machine, and session breakdowns
- Cache read and write efficiency
- Searchable session details
- Weekly and monthly session timelines

Costs are API-equivalent list-price estimates. They are not charges added to a ChatGPT, Claude, or Copilot subscription.

Each completed session becomes one JSON file under `<data-root>/logbook.d/`. A synced data folder can combine several Windows and macOS machines.

**Change Data Folder...** merges existing history into the selected ledger without replacing newer records. The original ledger is preserved as a backup by default and is removed only when the user explicitly disables that option after a successful migration.

## Application architecture

```text
Claude / Codex / Copilot hooks (automatic mode)
  -> installed standalone helper
  -> provider-specific transcript parser and pricing
  -> logbook.d/<session-id>.json

Provider transcript discovery (all modes)
  -> launch / refresh reconciliation
  -> logbook.d/<session-id>.json

Agent Usage Stat desktop application
  -> Electron lifecycle and user workflows
  -> HelperRuntime -> stable installed helper
  -> PortalRuntime -> generated snapshot -> aus:// renderer
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
