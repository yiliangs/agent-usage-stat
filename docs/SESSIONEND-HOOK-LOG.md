# Hook capture reliability

Claude Code does not reliably wait for `SessionEnd` hooks during `/exit` or terminal close. It can tear down the hook process tree within roughly one second. `/clear` often hides the problem because Claude Code remains alive. Continuous capture therefore uses both `Stop` for per-turn checkpoints and `SessionEnd` for a final best-effort checkpoint; neither event is treated as a durability guarantee.

The integration therefore uses a small synchronous shim. It reads stdin, checks the transcript entrypoint, writes a temporary input file, spawns a detached capture worker, and exits. The worker performs parsing, pricing, and shard writing after the host process is gone.

## Diagnostic signatures

The hook log is `~/.agent-usage-stat/hook.log`.

| Pattern | Meaning |
|---|---|
| `shim spawned worker` followed by `invoke` and `done` | Healthy |
| `shim spawned worker` without `invoke` | Worker was killed before startup |
| No `shim` line | Wrapper or hook never started |
| `shim skip: non-interactive entrypoint=sdk-cli` | Intentional automation skip |
| Worker enters manual mode after a hook | Temporary hook input was missing or invalid |

## Checks

```bash
time (printf '' | node dist/helper.js capture --detach)
time node dist/helper.js --version
```

Manual checks validate startup and wiring. Only a real Claude Code `/exit` validates survival during host teardown.

## Invariants

1. `src/cli.ts`, `src/commands/detach-shim.ts`, and `src/utils/hook-log.ts` may import only lightweight modules on the shim path.
2. The shim does only stdin read, entrypoint gate, temporary file write, detached spawn, and exit.
3. Do not mark Claude `Stop` or `SessionEnd` hooks async. The host must wait long enough for the shim to spawn its worker.
4. Read no more than 128 KB from a transcript for the entrypoint gate.
5. Use valid JSON paths in synthetic hook tests. Raw Windows backslashes are invalid JSON escapes.
6. Validate changes with a real `/exit`, not only `/clear`.
7. Codex transcript parsing and usage pricing share one incremental snapshot. Do not reintroduce independent full-file scans.
8. Persistent Codex caches are derived acceleration only. The rollout and immutable logbook shard remain the sources of truth.
9. Claude billing and metadata share one incremental session-tree snapshot. A `Stop` checkpoint must not rescan the main transcript or accumulated subagent files.
10. Hook configuration is best effort. Application launch and Sync now must always run provider reconciliation in both capture policies. Setup and uninstall apply every host behind its own error boundary, so one unreadable hook file is a reported per-host skip rather than a failed run.

The `AGENT_USAGE_STAT_ALL_SESSIONS=1` environment variable disables the Claude automation gate when SDK session capture is intentional.

## Incremental Codex snapshots

Codex rollout files can exceed 100 MB during long sessions. The provider keeps a versioned per-rollout snapshot under `~/.agent-usage-stat/cache/codex/` with the processed byte cursor, a rolling tail fingerprint, usage totals, model splits, turn data, and transcript metadata. A normal Stop capture reads only complete bytes appended since the prior capture; an incomplete final JSONL line is deferred until a later capture completes it.

Parser or pricing-version changes, truncation, replacement, and fingerprint mismatch invalidate the snapshot and trigger one full rebuild. Cache loss affects performance only, not recorded usage correctness.

## Incremental Claude snapshots

Claude main transcripts and recursive subagent transcripts are also append-only in normal operation. Continuous checkpoints keep a versioned session-tree snapshot under `~/.agent-usage-stat/cache/claude/`. Each file has its own byte cursor and rolling tail while billing deduplication remains shared across the tree. New subagent files are incorporated without rereading prior files; partial final JSONL records are deferred. File removal, truncation, replacement, parser changes, or pricing changes rebuild the derived snapshot.

The hook observation files under `~/.agent-usage-stat/capture-health/` record the last observed attempt, last successful checkpoint, and last failure separately. Absence of a failure does not prove that a host invoked its hook.

## Desktop capture monitor

The portal combines local hook configuration with the observation files above. It reports:

- `Observed` only after a configured hook has delivered a successful attempt.
- `Warning` when configuration is present but no attempt has been observed, or when the latest attempt failed. Neither state asks the user for anything: the first is unproven, the second clears itself on the next successful checkpoint.
- `Needs attention` when configuration is missing, disabled, or unreadable.
- `Batch sync` when hook capture is intentionally disabled by policy.
- `Not detected` when the local provider data folder is absent.

The monitor does not expire an observation based on elapsed time. A quiet agent and a host that stopped delivering hooks are indistinguishable without a new event. App launch and Sync now remain the recovery path in every state.

Configuration inspection covers local Windows and macOS installations. WSL, containers, remote development hosts, and web-only agent environments are outside the supported monitor boundary.

## opencode plugin capture

opencode loads every `.js` file in its global plugin directory at startup, so
the integration is a dedicated file we own outright and no shared configuration
is edited. Verified on opencode 1.18.19 (Windows 11) by dropping a bare module
into `~/.config/opencode/plugin/` and watching it receive the event stream.

The plugin subscribes to `session.idle`, whose payload carries the session id at
`event.properties.sessionID`. It spawns the installed helper detached, writes a
`SessionEnd`-shaped payload to the worker's stdin, and returns without awaiting,
so opencode capture reaches the same detach shim, correlated run protocol, and
capture-health record as every other host.

Constraints the generated plugin must keep:

1. No import beyond Node built-ins. opencode installs nothing on its behalf.
2. No throw that escapes into opencode's event loop.
3. No await on the capture worker. Recording never holds up a session.

`session.idle` fires at every quiet point, not only at exit, so a long session
checkpoints repeatedly. The shard writer is idempotent and never lowers a
recorded value, so the extra fires are free checkpoints rather than a hazard.

opencode's data root and its plugin directory are different XDG directories. A
custom data root moves only where sessions are read from; the plugin stays where
opencode loads plugins from.

## Same-terminal completion status

Setup installs shell functions for `claude`, `codex`, and `claudex`. Each
function launches the real command through `agent-usage-stat run`, which owns
the current terminal while the agent is active.

The runner creates `~/.agent-usage-stat/runs/<run-id>/` and passes the run ID in
`AGENT_USAGE_STAT_RUN_ID`. A hook input under `pending/` is the in-flight marker.
The worker publishes one immutable result under `results/` only after recording
reaches a terminal outcome. `recorded` means `LogbookWriter.append()` completed
its shard write and read-back check. The runner waits for all pending work plus
a short quiet period, prints one aggregate line, and preserves the agent's exit
code.

Terminal feedback is secondary to capture reliability:

1. If correlated state cannot be created, the shim falls back to its normal
   operating-system temp file and still spawns the worker.
2. The shim never waits, polls, loads config, or writes to the terminal.
3. A missing or timed-out result must never be reported as recorded.
4. Claudex inherits the run ID and its underlying Claude hook remains the source
   of the result.
