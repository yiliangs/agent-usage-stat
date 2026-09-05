# Agent Usage Stat

Agent Usage Stat is a standalone desktop analytics application for Claude Code, Codex, GitHub Copilot CLI, and opencode usage.

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
Claude SessionEnd / Codex Stop / Copilot SessionEnd / opencode session.idle hooks
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
- `src/core/helper-installation.ts`: the one owner of putting the capture helper on disk
- `src/desktop/helper-runtime.ts`: helper execution and first-run state
- `src/desktop/portal-runtime.ts`: `aus://` protocol, refresh serialization, and analytics snapshots
- `src/desktop/logbook-watcher.ts`: debounced shard-write observer behind the dashboard's auto-refresh
- `src/desktop/status-area.ts`: the notification-area icon and the glance panel window behind it
- `src/desktop/status-area-policy.ts`: which platforms carry that icon, and where its panel opens
- `src/helper.ts`: standalone headless helper entry
- `src/commands/setup.ts`: setup flow and terminal-wrapper installation
- `src/integrations/agent-integrations.ts`: the single registry for host detection and hook lifecycle
- `src/utils/provider-data-roots.ts`: the two path axes per host, session records and hook location
- `src/providers/opencode/database.ts`: read-only access to opencode's single SQLite store
- `src/core/logbook-writer.ts`: idempotent per-session shard writer
- `src/core/project-name.ts`: the single owner of project attribution, including the worktree layouts each agent CLI creates
- `src/core/pricing-feed.ts`: cached remote pricing snapshot for models the baked tables miss
- `src/utils/capture-run.ts`: machine-local run and capture-result protocol
- `src/utils/atomic-file.ts`: the one owner of replacing a file whole, and of the once-only pre-install backup
- `src/utils/usage-root.ts`: the only data-root resolver
- `portal/scripts/build-data.mjs`: browser artifact builder
- `portal/index.html`: integrated analytics layout and visual system
- `portal/panel.html`: the status-area glance, the portal's second document
- `portal/logo.svg`: the single brand source, feeding the header mark, the favicon, and every OS icon
- `portal/fonts/`: the typefaces the application ships, and their licence
- `portal/portal.js`: client-side aggregation, navigation, charts, tables, and detail interactions
- `portal/usage-format.js`: numeric formats, each bounded to the width of the slot it feeds
- `portal/usage-model.js`: the one owner of normalization, summing, and calendar bucketing
- `portal/pattern-model.js`: the selected period folded onto the clock and the week, behind the Pattern view
- `portal/glance-model.js`: which sessions the status-area panel counts, its charts, and the strings it prints
- `portal/timeline-colors.js`: the portal's two colour axes, project and model family
- `scripts/portal-probe-runner.mjs`: the one headless-Chrome harness the rendered-layout guards share
- `scripts/measure-portal-layout.mjs`: catches panels whose numbers wrap or clip
- `scripts/portal-timeline-probe.js`: reports what each session block on the timeline actually draws
- `scripts/portal-heatmap-probe.js`: reports what clicking each heatmap day cell opens
- `scripts/typeface-probe.js`: reports faces a rendered surface draws with but does not ship
- `scripts/install-local.mjs`: refreshes the installed application in place from a packaged build

## Invariants

- `logbook.d/` is the only spend source. Never revive or merge a shared CSV.
- `provider` is the host tool; model vendor is a separate axis. Claude Code can route to GPT, so never pick a pricing table or a chart series by provider alone. Derive vendor per model via `src/core/model-vendor.ts`.
- Persist `model_breakdowns` on every shard. Session totals alone cannot be split by vendor after the fact.
- Never let a recomputation replace a recorded session with lower tokens. Cumulative tokens order two observations of one session; cost does not, because a pricing correction lowers the rate underneath reads already on disk. Keep the winning observation whole rather than merging the two: totals, breakdown, turns, and time window came from one transcript read and agree only with each other.
- A session's project comes from `project-name.ts` and nowhere else. `cwd` is the recorded fact; `project` is derived from it, so a worktree checkout counts toward the project it was cut from rather than the worktree directory. The portal re-derives it for shards written before a layout was known, and otherwise leaves a recorded name alone.
- Every numeric format that feeds a single-line panel slot is bounded in `portal/usage-format.js` and declared in `SLOT_BUDGET`. Panels are sized once; the values they hold are not.
- Which events carry a session's tokens is decided once, by `usageEvents` in `portal/usage-model.js`: the turns when their breakdown accounts for the session total, the session itself otherwise. Every view that plots completion time reads it, so two views cannot disagree about when volume landed.
- A project's colour is assigned once per snapshot, into `state.projectColors`, and every surface drawing projects reads that index. A view building its own gives one project two colours.
- The portal names no colour a palette variable does not own. Dark mode redefines every entry in `:root` and leaves a literal untouched, so a hard-coded hue survives the switch and lands unreadable.
- The portal builds two documents from one Vite root: `index.html` for the dashboard and `panel.html` for the status-area glance. Both read the same generated snapshot, and both take summing, day bucketing, traffic bins, and series colours from `usage-model.js`, `token-traffic.js`, and `timeline-colors.js`; neither aggregates the ledger on its own.
- The status-area icon exists on Windows only, decided in `status-area-policy.ts`. Wherever it exists, closing the dashboard hands the application to it rather than quitting, and its panel window is what keeps the process alive.
- The panel document draws the panel's only frame. Its window is transparent so it reserves no non-client margin: the window rect is the content rect, `PANEL_SIZE` means on screen what `panelPlacement` clamps against, and the shell's own window border never lands on the hairline the document draws at the edge of its content.
- Every asset `portal/index.html` references lives inside the Vite root. A path that leaves `portal/` resolves during the build and falls through to the SPA fallback in the development server.
- The application ships the faces it is designed in. Naming a family in `--sans`, `--mono`, or `--serif` only states a preference, so a machine without it falls silently through to the next entry in the list. Both surfaces that declare those tokens carry their own faces: the dashboard from `portal/fonts/`, the first-run window inline, because it loads from a `data:` URL and has no path to resolve against. Bundle the weights the rendered surface asks for, measured rather than read off the declarations.
- Parse JSONL line by line with per-line error isolation. opencode's records are JSON bodies in database columns; parse them per row with the same isolation.
- opencode keeps every session in one SQLite database, so `FoundSession.transcriptPath` is that database and the session id is the key, not a fallback. A session's usage folds in its `parent_id` descendants.
- A host's hook root follows its data root, including an override, unless the host declares a separate hook directory. Only opencode does.
- `providerID` in an opencode message is routing, never the model's vendor.
- Every setup decision is a `SetupQuestion` from `src/desktop/setup-question.ts`, never a shape built for one renderer. The first-run window answers them inline through `startup-screen.ts`; the dashboard, which has no such surface, is the only caller that may hand one to a native dialog. The OS folder picker is not a question and stays native.
- The first-run sequence lives once, in `FIRST_RUN_STEPS`. The spine, the headline, and the step prose all read from it, so a lifecycle call site names a step rather than repeating its copy.
- Normalize model bracket suffixes before pricing lookup.
- Baked pricing tables are authoritative. The remote pricing feed only prices models they miss, its refresh is best-effort and never blocks or fails capture, and the active snapshot is pinned into transcript fingerprints so repricing stays deterministic.
- A pricing miss, not the clock, is what says the feed snapshot is incomplete. Capture asks for a refresh on that evidence, bounded by the feed's attempt backoff, and reads the transcript again when the snapshot changed, because a record's cost and the fingerprint pinning it must come from one read.
- Claude subagent usage includes recursively nested workflow transcripts.
- Copilot usage comes from the persisted `session.shutdown.modelMetrics` aggregate; incomplete sessions without shutdown are not capture candidates.
- opencode records input excluding cache reads and output excluding reasoning; fold reasoning into output before pricing. Its own per-message `cost` prices only what the baked tables and the feed both miss.
- `helper.ts`, `detach-shim.ts`, and `hook-log.ts` must remain import-light.
- The detach shim reads at most the first 128 KB when checking Claude entrypoints.
- Terminal feedback must fall back silently rather than weaken detached capture.
- Production opens no localhost server. Renderer assets and data use the `aus://` protocol.
- Hooks must target the stable installed helper, never a versioned application directory.
- The Start Menu entry is `Programs\<Product>.lnk`, listed as an application rather than filed in a folder. Squirrel writes it into a folder named after the nuspec authors and offers no location that skips one, and that same field is the uninstall entry's Publisher, so `src/desktop/start-menu-shortcut.ts` moves the shortcut instead of renaming the author.
- Resolve machine-specific paths through `usage-root.ts`; do not hardcode them.
- Replacing a file goes through `atomic-file.ts`: stage a sibling and rename over the target, never truncate in place. A ledger root is routinely Google Drive File Stream, so the window a partial write leaves open is real. A host config's `.backup` is the pristine pre-install copy, taken once and never overwritten by a later install.
- Before changing hook behavior, read `docs/SESSIONEND-HOOK-LOG.md`.

## Documents

Markdown lives under `docs/`. The repository root carries only `README.md`,
`LICENSE`, `AGENTS.md`, and `CLAUDE.md`; nothing else is added there.

- `docs/plans/`: plans, proposals, and design notes, one file per subject in
  kebab case. The directory is gitignored, so a plan stays local to the machine
  that wrote it. Write a plan here rather than at the root, and state its status
  in the opening lines so a later reader knows whether it was executed.
- `docs/`: tracked reference that is not a plan, such as
  `SESSIONEND-HOOK-LOG.md`.

## Platform

- ESM only
- Node.js 20 or newer
- Windows and macOS are first-class
- End-user capture runs through a bundled Node single executable application, not system Node.js
