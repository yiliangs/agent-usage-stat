import { mkdirSync } from "fs";
import { readFile } from "fs/promises";
import { basename, dirname } from "path";
import { hostname } from "os";
import { writeJsonAtomic } from "../utils/atomic-file.js";
import type { ProviderSessionSnapshot } from "../types/provider.js";
import { vendorForModel } from "./model-vendor.js";
import { projectNameForCwd } from "./project-name.js";
import { withShardLock } from "./shard-lock.js";
import {
  shardPathFor,
  type LogbookModelRecord,
  type LogbookRecord,
} from "./usage-ledger.js";

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
  async append(root: string, data: ProviderSessionSnapshot): Promise<string> {
    let record = this.buildRecord(data);
    // A record always carries the session id its provider reported, so the key
    // here is the one sync fingerprints against. The slug-and-time fallback
    // covers only a record with no id at all, which no provider produces.
    const path = shardPathFor(
      root,
      record.session_id ||
        `${record.session_slug || "session"}-${record.end_time}`,
    );
    mkdirSync(dirname(path), { recursive: true });

    return withShardLock(path, async () => {
      record = await this.preserveRecordedUsage(path, record);
      await writeJsonAtomic(path, record, 2);

      // Read the bytes back: Drive can accept a write and later revert it, and a
      // unique new file is the case that has always persisted, so a mismatch here
      // is a real red flag worth surfacing rather than trusting the write blind.
      const back = JSON.parse(await readFile(path, "utf-8")) as LogbookRecord;
      if (back.session_id !== record.session_id) {
        throw new Error(`shard verify mismatch for ${basename(path)}`);
      }
      return path;
    });
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
      model_breakdowns:
        existing.model_breakdowns ??
        soleModelBreakdown(existing) ??
        measuredSplitOf(existing, next),
      // The source was successfully examined even when its recomputation was
      // lower. Advancing the fingerprint prevents an unchanged truncated or
      // pruned transcript from being retried on every reconciliation.
      source_fingerprint: next.source_fingerprint,
    };
  }

  private buildRecord(data: ProviderSessionSnapshot): LogbookRecord {
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
      unpriced_models: [...new Set(data.unknownModels)].sort(),
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
 * implies no such split from its totals alone; `measuredSplitOf` decides
 * whether the rejected read supplies one.
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

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_tokens",
  "cache_read_tokens",
] as const;

/**
 * The breakdown a multi-model legacy shard is given when a rejected recompute
 * measured how the same session divided among the same models (#85).
 *
 * The shard's totals stand, so the recompute's breakdown cannot be written as
 * it is: it sums to the read that lost. Its proportions are still the only
 * per-model evidence this session will ever have, because the fingerprint
 * advances and no later sync revisits the shard, and the reader's alternative
 * is an even split between models that measured nothing. So each recorded
 * component, and the recorded cost, is apportioned over the models in the
 * proportion the recompute found for that component, and the breakdown sums
 * to the recorded totals exactly.
 *
 * The recompute must name exactly the models the shard records. A read that
 * never saw a recorded model cannot say what that model earned, and a split
 * that charges its spend to another model is the invention this refuses; that
 * shard keeps no breakdown and the reader's legacy fallback stands.
 */
function measuredSplitOf(
  existing: LogbookRecord,
  next: LogbookRecord,
): LogbookModelRecord[] | undefined {
  const fresh = next.model_breakdowns ?? [];
  const recorded = [...new Set(existing.models ?? [])].sort();
  const measured = [...new Set(fresh.map((entry) => entry.model))].sort();
  if (
    !recorded.length ||
    fresh.length !== measured.length ||
    recorded.join("\n") !== measured.join("\n")
  ) {
    return undefined;
  }

  const byTokens = fresh.map((entry) => entry.total_tokens);
  const components = TOKEN_FIELDS.map((field) =>
    apportion(
      existing[field],
      fresh.map((entry) => entry[field]),
      byTokens,
    ),
  );
  const microDollars = apportion(
    Math.round(existing.total_cost_usd * 1e6),
    fresh.map((entry) => entry.total_cost_usd),
    byTokens,
  );
  if (components.some((split) => !split) || !microDollars) return undefined;

  return fresh.map((entry, index) => {
    const [input, output, cacheCreation, cacheRead] = components.map(
      (split) => split![index],
    );
    return {
      model: entry.model,
      vendor: entry.vendor ?? vendorForModel(entry.model),
      input_tokens: input,
      output_tokens: output,
      cache_creation_tokens: cacheCreation,
      cache_read_tokens: cacheRead,
      total_tokens: input + output + cacheCreation + cacheRead,
      total_cost_usd: microDollars[index] / 1e6,
    };
  });
}

/**
 * Divide a whole number in proportion to `weights`, falling back to
 * `fallback` when the weights are all zero, by largest remainder so the parts
 * sum to the whole exactly. Undefined when neither set of weights has mass.
 */
function apportion(
  whole: number,
  weights: number[],
  fallback: number[],
): number[] | undefined {
  const total = (values: number[]) =>
    values.reduce((sum, value) => sum + Math.max(0, value || 0), 0);
  const basis = total(weights) > 0 ? weights : fallback;
  const mass = total(basis);
  if (!(whole > 0)) return basis.map(() => 0);
  if (!(mass > 0)) return undefined;

  const exact = basis.map((weight) => (Math.max(0, weight || 0) / mass) * whole);
  const parts = exact.map(Math.floor);
  let left = whole - parts.reduce((sum, part) => sum + part, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] += 1;
    left -= 1;
  }
  return parts;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
