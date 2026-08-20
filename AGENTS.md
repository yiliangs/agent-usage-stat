# Agent Usage Stat

Agent Usage Stat is a standalone desktop analytics application for Claude Code, Codex, and GitHub Copilot CLI usage.

## Commands

```bash
npm test
npm run test:desktop
npm run build
npm start
npm run make
npm run install:local
node dist/helper.js capture --session <id>
```

`npm run install:local` replaces the payload behind the installed shortcut with
the current working tree, so one installation serves both daily use and local
iteration. It packages, copies, then prunes its staging tree, leaving exactly
one application on the machine. It needs an installation to already exist;
create that once from the installer `npm run make` writes to `dist/forge/make`.

## Data flow

```text
Claude SessionEnd / Codex Stop / Copilot SessionEnd hooks
  -> installed standalone helper
  -> detach-shim.ts
  -> CaptureCommand
  -> provider-specific transcript parser and pricing
  -> LogbookWriter
  -> <dataRoot>/logbook.d/<session-id>.json
  -> portal/scripts/build-data.mjs
  -> packaged Electron renderer
```

Everything upstream of `SessionUsage` and `ParsedTranscript` is provider-specific. Everything downstream consumes only those normalized types. Add a provider under `src/providers/<name>/`; do not add provider branches to the portal or shard writer.

## Key modules

- `src/commands/capture.ts`: session ingestion
- `src/commands/run.ts`: current-terminal agent wrapper and completion status
- `src/desktop/main.ts`: Electron lifecycle, windows, menus, and user-facing setup flows
- `src/desktop/helper-runtime.ts`: stable helper installation, execution, and first-run state
- `src/desktop/portal-runtime.ts`: `aus://` protocol, refresh serialization, and analytics snapshots
- `src/desktop/logbook-watcher.ts`: debounced shard-write observer behind the dashboard's auto-refresh
- `src/helper.ts`: standalone headless helper entry
- `src/commands/setup.ts`: setup flow and terminal-wrapper installation
- `src/integrations/agent-integrations.ts`: the single registry for host detection and hook lifecycle
- `src/core/logbook-writer.ts`: idempotent per-session shard writer
- `src/core/pricing-feed.ts`: cached remote pricing snapshot for models the baked tables miss
- `src/utils/capture-run.ts`: machine-local run and capture-result protocol
- `src/utils/usage-root.ts`: the only data-root resolver
- `portal/scripts/build-data.mjs`: browser artifact builder
- `portal/index.html`: integrated analytics layout and visual system
- `portal/logo.svg`: the single brand source, feeding the header mark, the favicon, and every OS icon
- `portal/portal.js`: client-side aggregation, navigation, charts, tables, and detail interactions
- `portal/usage-format.js`: numeric formats, each bounded to the width of the slot it feeds
- `scripts/measure-portal-layout.mjs`: renders the built portal in headless Chrome to catch overflowing panels
- `scripts/install-local.mjs`: refreshes the installed application in place from a packaged build

## Invariants

- `logbook.d/` is the only spend source. Never revive or merge a shared CSV.
- `provider` is the host tool; model vendor is a separate axis. Claude Code can route to GPT, so never pick a pricing table or a chart series by provider alone. Derive vendor per model via `src/core/model-vendor.ts`.
- Persist `model_breakdowns` on every shard. Session totals alone cannot be split by vendor after the fact.
- Never let a recomputation replace a recorded session with lower tokens or cost.
- Every numeric format that feeds a single-line panel slot is bounded in `portal/usage-format.js` and declared in `SLOT_BUDGET`. Panels are sized once; the values they hold are not.
- Every asset `portal/index.html` references lives inside the Vite root. A path that leaves `portal/` resolves during the build and falls through to the SPA fallback in the development server.
- Parse JSONL line by line with per-line error isolation.
- Normalize model bracket suffixes before pricing lookup.
- Baked pricing tables are authoritative. The remote pricing feed only prices models they miss, its refresh is best-effort and never blocks or fails capture, and the active snapshot is pinned into transcript fingerprints so repricing stays deterministic.
- Claude subagent usage includes recursively nested workflow transcripts.
- Copilot usage comes from the persisted `session.shutdown.modelMetrics` aggregate; incomplete sessions without shutdown are not capture candidates.
- `helper.ts`, `detach-shim.ts`, and `hook-log.ts` must remain import-light.
- The detach shim reads at most the first 128 KB when checking Claude entrypoints.
- Terminal feedback must fall back silently rather than weaken detached capture.
- Production opens no localhost server. Renderer assets and data use the `aus://` protocol.
- Hooks must target the stable installed helper, never a versioned application directory.
- Resolve machine-specific paths through `usage-root.ts`; do not hardcode them.
- Before changing hook behavior, read `SESSIONEND-HOOK-LOG.md`.

## Platform

- ESM only
- Node.js 20 or newer
- Windows and macOS are first-class
- End-user capture runs through a bundled Node single executable application, not system Node.js
