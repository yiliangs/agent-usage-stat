import { mkdirSync } from "fs";
import { writeFile, readFile, open, stat, unlink } from "fs/promises";
import { join } from "path";
import { hostname } from "os";
import type { SessionUsage } from "../types/session.js";
import type { ParsedTranscript } from "../types/transcript.js";
import { vendorForModel } from "./model-vendor.js";
import { projectNameForCwd } from "./project-name.js";
import {
  LOGBOOK_SHARD_DIR,
  type LogbookModelRecord,
  type LogbookRecord,
} from "./usage-ledger.js";

export interface UsageRecordData {
  sessionData: SessionUsage;
  transcriptData: ParsedTranscript;
}

/**
 * Records one session per JSON file under <root>/logbook.d/.
 *
 * Why per-session files instead of one append-only logbook.csv: the logbook
 * lives on Google Drive File Stream and is shared across machines. Appending
 * rewrites the whole shared file, and Drive resolves any version skew with
 * last-writer-wins, silently dropping rows that lose the race. Giving every
 * session its own uniquely named file removes the conflict surface entirely.
 *
 * A resumed session fires SessionEnd more than once with the same id and grown
 * usage; re-writing the same-named shard keeps one record holding the latest
 * figures. The portal reads these shards directly through its data build step.
 */
export class LogbookWriter {
  /**
   * Write this session's shard and return its path. Throws on failure — the
   * old single CSV writer swallowed every error, which is exactly how the data
   * loss stayed invisible. The caller logs the outcome.
   */
  async append(root: string, data: UsageRecordData): Promise<string> {
    const dir = join(root, LOGBOOK_SHARD_DIR);
    mkdirSync(dir, { recursive: true });

    let record = this.buildRecord(data);
    const base =
      record.session_id ||
      `${record.session_slug || "session"}-${record.end_time}`;
    const name = base.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(dir, `${name}.json`);

    return this.withShardLock(path, async () => {
      record = await this.preserveRecordedUsage(path, record);
      await writeFile(path, JSON.stringify(record, null, 2), "utf-8");

      // Read the bytes back: Drive can accept a write and later revert it, and a
      // unique new file is the case that has always persisted, so a mismatch here
      // is a real red flag worth surfacing rather than trusting the write blind.
      const back = JSON.parse(await readFile(path, "utf-8")) as LogbookRecord;
      if (back.session_id !== record.session_id) {
        throw new Error(`shard verify mismatch for ${name}.json`);
      }
      return path;
    });
  }

  /** Serialize detached workers that update the same rollout shard. */
  private async withShardLock<T>(
    path: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const lockPath = `${path}.lock`;
    let handle;

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.removeStaleLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    if (!handle) {
      throw new Error(`timed out waiting for shard lock: ${lockPath}`);
    }

    try {
      return await action();
    } finally {
      await handle.close();
      try {
        await unlink(lockPath);
      } catch {
        // Another process may already have cleaned up a stale lock.
      }
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs <= 30_000) return;
      await unlink(lockPath);
    } catch {
      // The owner released it between our failed open and this check.
    }
  }

  /**
   * Detached hook workers can finish out of order. Never let an older partial
   * rollout replace a later, larger usage snapshot for the same session.
   *
   * Cumulative tokens are what order two observations of one session. A
   * session only ever accumulates them, so fewer tokens means an earlier read.
   * Cost orders nothing: it is those tokens times a rate, and a pricing
   * correction lowers that rate underneath reads already on disk. A session
   * that grew and repriced downward is a later observation, not a regression.
   *
   * The winner is kept whole rather than merged field by field. A record's
   * totals, its per-model breakdown, its turns, and its time window all came
   * from one transcript read, and they agree only with each other.
   */
  private async preserveRecordedUsage(
    path: string,
    next: LogbookRecord,
  ): Promise<LogbookRecord> {
    let existing: LogbookRecord;
    try {
      existing = JSON.parse(await readFile(path, "utf-8")) as LogbookRecord;
    } catch {
      return next;
    }

    if (
      existing.session_id !== next.session_id ||
      (existing.provider || "claude") !== next.provider
    ) {
      return next;
    }

    if (next.total_tokens >= existing.total_tokens) return next;

    return {
      ...existing,
      model_breakdowns: existing.model_breakdowns ?? soleModelBreakdown(existing),
      // The source was successfully examined even when its recomputation was
      // lower. Advancing the fingerprint prevents an unchanged truncated or
      // pruned transcript from being retried on every reconciliation.
      source_fingerprint: next.source_fingerprint,
    };
  }

  private buildRecord(data: UsageRecordData): LogbookRecord {
    const { sessionData, transcriptData } = data;
    const durationMs =
      transcriptData.endTime.getTime() - transcriptData.startTime.getTime();
    const durationSec = Math.max(0, Math.floor(durationMs / 1000));
    const models = sessionData.modelBreakdowns.map((model) => model.modelName);

    return {
      timestamp: transcriptData.endTime.toISOString(),
      session_slug: transcriptData.sessionSlug || "",
      session_id: sessionData.sessionId || "",
      project: projectNameForCwd(transcriptData.cwd),
      branch: transcriptData.gitBranch || "",
      cwd: transcriptData.cwd || "",
      machine: hostname(),
      start_time: transcriptData.startTime.toISOString(),
      end_time: transcriptData.endTime.toISOString(),
      duration_seconds: durationSec,
      duration_human: formatDuration(durationSec),
      input_tokens: sessionData.inputTokens,
      output_tokens: sessionData.outputTokens,
      cache_creation_tokens: sessionData.cacheCreationTokens,
      cache_read_tokens: sessionData.cacheReadTokens,
      total_tokens: sessionData.totalTokens,
      total_cost_usd: Number(sessionData.totalCost.toFixed(6)),
      models,
      model_breakdowns: sessionData.modelBreakdowns.map((breakdown) => ({
        model: breakdown.modelName,
        vendor: vendorForModel(breakdown.modelName),
        input_tokens: breakdown.inputTokens,
        output_tokens: breakdown.outputTokens,
        cache_creation_tokens: breakdown.cacheCreationTokens,
        cache_read_tokens: breakdown.cacheReadTokens,
        total_tokens:
          breakdown.inputTokens +
          breakdown.outputTokens +
          breakdown.cacheCreationTokens +
          breakdown.cacheReadTokens,
        total_cost_usd: Number(breakdown.cost.toFixed(6)),
      })),
      turns: sessionData.turns?.map((turn) => ({
        turn_id: turn.id,
        start_time: turn.startTime,
        end_time: turn.endTime,
        input_tokens: turn.inputTokens,
        output_tokens: turn.outputTokens,
        cache_creation_tokens: turn.cacheCreationTokens,
        cache_read_tokens: turn.cacheReadTokens,
        total_tokens: turn.totalTokens,
        total_cost_usd: Number(turn.totalCost.toFixed(6)),
        models: turn.modelBreakdowns.map((model) => model.modelName),
      })),
      source_fingerprint: sessionData.sourceFingerprint,
      provider: sessionData.provider,
    };
  }
}

/**
 * The breakdown a shard written before `model_breakdowns` existed already
 * implies when it names exactly one model: that model holds every token and
 * every dollar the record carries, so the split is read off the record rather
 * than estimated from a read that saw less. A record naming several models
 * implies no such split from its totals alone and is given none, which is what
 * the reader's legacy `models` fallback exists to cover.
 */
function soleModelBreakdown(
  record: LogbookRecord,
): LogbookModelRecord[] | undefined {
  if (record.models?.length !== 1) return undefined;
  const [model] = record.models;
  return [{
    model,
    vendor: vendorForModel(model),
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    cache_creation_tokens: record.cache_creation_tokens,
    cache_read_tokens: record.cache_read_tokens,
    total_tokens: record.total_tokens,
    total_cost_usd: record.total_cost_usd,
  }];
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
