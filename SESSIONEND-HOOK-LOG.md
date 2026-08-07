# Hook capture reliability

Claude Code does not reliably wait for `SessionEnd` hooks during `/exit` or terminal close. It can tear down the hook process tree within roughly one second. `/clear` often hides the problem because Claude Code remains alive.

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
time (printf '' | bash bin/run-hook.sh capture --detach --quiet)
time node dist/helper.js --version
```

Manual checks validate startup and wiring. Only a real Claude Code `/exit` validates survival during host teardown.

## Invariants

1. `src/cli.ts`, `src/commands/detach-shim.ts`, and `src/utils/hook-log.ts` may import only lightweight modules on the shim path.
2. The shim does only stdin read, entrypoint gate, temporary file write, detached spawn, and exit.
3. Do not mark the Claude `SessionEnd` hook async. The host must wait long enough for the shim to spawn its worker.
4. Keep Node resolution in `bin/run-hook.sh`. Never write an absolute Node executable into host settings.
5. Read no more than 128 KB from a transcript for the entrypoint gate.
6. Use valid JSON paths in synthetic hook tests. Raw Windows backslashes are invalid JSON escapes.
7. Validate changes with a real `/exit`, not only `/clear`.
8. Keep `bin/run-hook.sh` executable in Git.
9. Codex transcript parsing and usage pricing share one incremental snapshot. Do not reintroduce independent full-file scans.
10. Persistent Codex caches are derived acceleration only. The rollout and immutable logbook shard remain the sources of truth.

The `AGENT_USAGE_STAT_ALL_SESSIONS=1` environment variable disables the Claude automation gate when SDK session capture is intentional.

## Incremental Codex snapshots

Codex rollout files can exceed 100 MB during long sessions. The provider keeps a versioned per-rollout snapshot under `~/.agent-usage-stat/cache/codex/` with the processed byte cursor, a rolling tail fingerprint, usage totals, model splits, turn data, and transcript metadata. A normal Stop capture reads only complete bytes appended since the prior capture; an incomplete final JSONL line is deferred until a later capture completes it.

Parser or pricing-version changes, truncation, replacement, and fingerprint mismatch invalidate the snapshot and trigger one full rebuild. Cache loss affects performance only, not recorded usage correctness.

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
4. Claudex inherits the run ID and its underlying Claude `SessionEnd` hook
   remains the source of the result.
