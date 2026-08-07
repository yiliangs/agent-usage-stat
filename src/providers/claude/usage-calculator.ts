import { readFile } from "fs/promises";
import { existsSync } from "fs";
import {
  priceForRequest,
  normalizeModelId,
  priceMultiplierForSpeed,
} from "./pricing.js";
import { displayModelName } from "./model-names.js";
import { findSessionTranscriptFiles } from "./session-files.js";
import {
  fingerprintTranscriptContentPart,
  fingerprintTranscriptParts,
} from "./transcript-fingerprint.js";
import { expandHome } from "../../utils/paths.js";
import type { TranscriptMessage } from "./transcript-format.js";
import type {
  SessionUsage,
  ModelBreakdown,
  TurnUsage,
} from "../../types/session.js";

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

interface TemporalUsage {
  turns: TurnUsage[];
  complete: boolean;
}

/**
 * Sentinel model id Claude Code writes for synthetic assistant messages
 * (interrupts, API-error placeholders, subagent/sidechain artifacts). These
 * are not a real billed model — including them pollutes the model breakdown
 * with a phantom "<synthetic>" entry carrying no real usage. ccusage skips
 * them too.
 */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Compute session usage and cost directly from the transcript JSONL.
 *
 * Replaces the ccusage subprocess: same shape on output, but reads the
 * file Claude Code itself just wrote — so it's instantaneous and never
 * suffers the index-lag race that forced the old retry loop. Pricing
 * comes from the in-repo table; unknown models bill at $0 and surface
 * via getUnknownModels() so the caller can log them.
 */
export class UsageCalculator {
  private unknownModels = new Set<string>();

  async calculate(
    transcriptPath: string,
    sessionId: string,
  ): Promise<SessionUsage> {
    this.unknownModels.clear();
    const expanded = expandHome(transcriptPath);
    if (!existsSync(expanded)) {
      throw new Error(`Transcript file not found: ${transcriptPath}`);
    }

    const totalsByModel = new Map<string, ModelTotals>();
    // One assistant turn with N content blocks (text + tool_use…) is written
    // as N JSONL lines that share message.id + requestId and REPEAT the same
    // usage object — the usage is for the whole API response, not per block.
    // Summing every line multi-counts the same billing event (observed 3-5×,
    // ~3× cost inflation overall). Dedupe by message.id, which identifies one
    // API response. GPT responses omit requestId, so requiring both fields would
    // count every repeated content-block line.
    // The set is shared across the main transcript and all subagent files —
    // a billing event must count exactly once no matter where it appears.
    const seenBillingKeys = new Set<string>();
    const fingerprintParts: string[] = [];
    const temporal: TemporalUsage = { turns: [], complete: true };

    for (const file of await findSessionTranscriptFiles(expanded, sessionId)) {
      const part = await this.accumulateFile(
        file,
        totalsByModel,
        seenBillingKeys,
        temporal,
      );
      if (part) fingerprintParts.push(part);
    }

    const breakdowns: ModelBreakdown[] = [];
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreate = 0;
    let totalCacheRead = 0;

    for (const [model, t] of totalsByModel) {
      totalCost += t.cost;
      totalInput += t.inputTokens;
      totalOutput += t.outputTokens;
      totalCacheCreate += t.cacheCreationTokens;
      totalCacheRead += t.cacheReadTokens;

      breakdowns.push({
        modelName: model,
        displayName: displayModelName(model),
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheCreationTokens: t.cacheCreationTokens,
        cacheReadTokens: t.cacheReadTokens,
        cost: t.cost,
      });
    }

    // Sort by cost desc so the dominant model heads the breakdown
    breakdowns.sort((a, b) => b.cost - a.cost);

    const totalTokens =
      totalInput + totalOutput + totalCacheCreate + totalCacheRead;

    return {
      provider: "claude",
      sessionId,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheCreationTokens: totalCacheCreate,
      cacheReadTokens: totalCacheRead,
      totalTokens,
      totalCost,
      modelsUsed: breakdowns.map((b) => b.modelName),
      modelBreakdowns: breakdowns,
      turns: temporal.complete
        ? temporal.turns.sort(
            (a, b) => Date.parse(a.endTime) - Date.parse(b.endTime),
          )
        : undefined,
      sourceFingerprint: fingerprintTranscriptParts(fingerprintParts),
    };
  }

  /** Models priced at $0 because we have no entry. capture.ts logs these. */
  getUnknownModels(): string[] {
    return [...this.unknownModels];
  }

  /**
   * Sum one JSONL file's billing events into totalsByModel, deduping against
   * the shared seenBillingKeys set.
   */
  private async accumulateFile(
    path: string,
    totalsByModel: Map<string, ModelTotals>,
    seenBillingKeys: Set<string>,
    temporal: TemporalUsage,
  ): Promise<string | null> {
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch {
      // Subagent file vanished or unreadable, so skip it rather than fail capture.
      return null;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let msg: TranscriptMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.type !== "assistant" || !msg.message?.usage || !msg.message.model)
        continue;

      // Synthetic messages aren't a real model — skip so they never reach the
      // breakdown or the logbook `models` column.
      if (msg.message.model === SYNTHETIC_MODEL) continue;

      // Aggregate by normalized alias so "claude-opus-4-8", a dated snapshot,
      // and "claude-opus-4-8[1m]" land in one breakdown row, not three.
      const model = normalizeModelId(msg.message.model);

      // Skip repeated lines of the same multi-block turn (see seenBillingKeys).
      const msgId = msg.message.id;
      if (msgId) {
        if (seenBillingKeys.has(msgId)) continue;
        seenBillingKeys.add(msgId);
      }

      const u = msg.message.usage;

      const inputTokens = Math.max(0, u.input_tokens || 0);
      const outputTokens = Math.max(0, u.output_tokens || 0);
      const cacheCreationTokens = Math.max(
        0,
        u.cache_creation_input_tokens || 0,
      );
      const cacheReadTokens = Math.max(0, u.cache_read_input_tokens || 0);
      const pricing = priceForRequest(
        model,
        inputTokens + cacheCreationTokens + cacheReadTokens,
      );
      if (!pricing) this.unknownModels.add(model);

      const standardCost = pricing
        ? (inputTokens * pricing.input +
            outputTokens * pricing.output +
            cacheCreationTokens * pricing.cacheWrite +
            cacheReadTokens * pricing.cacheRead) /
          1_000_000
        : 0;
      const cost =
        standardCost * priceMultiplierForSpeed(model, u.speed);
      const breakdown: ModelBreakdown = {
        modelName: model,
        displayName: displayModelName(model),
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        cost,
      };
      const totals = totalsByModel.get(model) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cost: 0,
      };
      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
      totals.cacheCreationTokens += cacheCreationTokens;
      totals.cacheReadTokens += cacheReadTokens;
      totals.cost += cost;
      totalsByModel.set(model, totals);

      if (!msg.timestamp || Number.isNaN(Date.parse(msg.timestamp))) {
        temporal.complete = false;
      } else {
        temporal.turns.push({
          id:
            msgId ||
            msg.uuid ||
            msg.requestId ||
            `claude-response-${temporal.turns.length + 1}`,
          startTime: msg.timestamp,
          endTime: msg.timestamp,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          totalTokens:
            inputTokens +
            outputTokens +
            cacheCreationTokens +
            cacheReadTokens,
          totalCost: cost,
          modelsUsed: [model],
          modelBreakdowns: [breakdown],
        });
      }
    }
    return fingerprintTranscriptContentPart(content);
  }
}
