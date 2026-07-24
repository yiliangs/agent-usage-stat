# Agent Usage Stat

Agent Usage Stat is a local analytics portal for Claude Code and Codex usage.

## Commands

```bash
npm test
npm run build
npm run build:portal
node bin/agent-usage-stat.js portal
node bin/agent-usage-stat.js portal enable
node bin/agent-usage-stat.js capture --provider codex --session <id>
node bin/agent-usage-stat.js setup
```

## Data flow

```text
Claude SessionEnd / Codex Stop hooks
  -> detach-shim.ts
  -> CaptureCommand
  -> provider-specific transcript parser and pricing
  -> LogbookWriter
  -> <dataRoot>/logbook.d/<session-id>.json
  -> portal/scripts/build-data.mjs
  -> local React portal
```

Everything upstream of `SessionUsage` and `ParsedTranscript` is provider-specific. Everything downstream consumes only those normalized types. Add a provider under `src/providers/<name>/`; do not add provider branches to the portal or shard writer.

## Key modules

- `src/commands/capture.ts`: session ingestion
- `src/commands/run.ts`: current-terminal agent wrapper and completion status
- `src/commands/portal.ts`: local portal server
- `src/commands/setup.ts`: host hook and shell-wrapper installation
- `src/core/logbook-writer.ts`: idempotent per-session shard writer
- `src/utils/capture-run.ts`: machine-local run and capture-result protocol
- `src/utils/usage-root.ts`: the only data-root resolver
- `portal/scripts/build-data.mjs`: browser artifact builder
- `portal/src/`: analytics interface

## Invariants

- `logbook.d/` is the only spend source. Never revive or merge a shared CSV.
- `provider` is the host tool; model vendor is a separate axis. Claude Code can route to GPT, so never pick a pricing table or a chart series by provider alone. Derive vendor per model via `src/core/model-vendor.ts`.
- Persist `model_breakdowns` on every shard. Session totals alone cannot be split by vendor after the fact.
- Never let a recomputation replace a recorded session with lower tokens or cost.
- Parse JSONL line by line with per-line error isolation.
- Normalize model bracket suffixes before pricing lookup.
- Claude subagent usage includes recursively nested workflow transcripts.
- `cli.ts`, `detach-shim.ts`, and `hook-log.ts` must remain import-light.
- The detach shim reads at most the first 128 KB when checking Claude entrypoints.
- Terminal feedback must fall back silently rather than weaken detached capture.
- Keep `bin/run-hook.sh` and `portal/Agent-Usage-Stat.command` executable in Git.
- Resolve machine-specific paths through `usage-root.ts`; do not hardcode them.
- Before changing hook behavior, read `SESSIONEND-HOOK-LOG.md`.

## Platform

- ESM only
- Node.js 20 or newer
- Windows and macOS are first-class
- `bin/run-hook.sh` resolves Node through PATH, WinGet, Homebrew, then nvm
