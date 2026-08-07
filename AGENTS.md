# Agent Usage Stat

Agent Usage Stat is a local analytics portal for Claude Code, Codex, and GitHub Copilot CLI usage.

## Commands

```bash
npm test
npm run test:desktop
npm run build
npm run build:portal
npm start
npm run make
node dist/helper.js capture --session <id>
```

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
- `src/desktop/main.ts`: desktop lifecycle, application protocol, helper installation, and updates
- `src/helper.ts`: standalone headless helper entry
- `src/commands/setup.ts`: host hook and shell-wrapper installation
- `src/core/logbook-writer.ts`: idempotent per-session shard writer
- `src/utils/capture-run.ts`: machine-local run and capture-result protocol
- `src/utils/usage-root.ts`: the only data-root resolver
- `portal/scripts/build-data.mjs`: browser artifact builder
- `portal/index.html`: integrated analytics layout and visual system
- `portal/portal.js`: client-side aggregation, navigation, charts, tables, and detail interactions

## Invariants

- `logbook.d/` is the only spend source. Never revive or merge a shared CSV.
- `provider` is the host tool; model vendor is a separate axis. Claude Code can route to GPT, so never pick a pricing table or a chart series by provider alone. Derive vendor per model via `src/core/model-vendor.ts`.
- Persist `model_breakdowns` on every shard. Session totals alone cannot be split by vendor after the fact.
- Never let a recomputation replace a recorded session with lower tokens or cost.
- Parse JSONL line by line with per-line error isolation.
- Normalize model bracket suffixes before pricing lookup.
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
- `bin/run-hook.sh` resolves Node through PATH, WinGet, Homebrew, then nvm
