import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import ora from "ora";
import { ConfigManager } from "../core/config-manager.js";
import { LogbookWriter } from "../core/logbook-writer.js";
import { initializePricingFeed } from "../core/pricing-feed.js";
import {
  LOGBOOK_SHARD_DIR,
  type LogbookRecord,
} from "../core/usage-ledger.js";
import { allProviders } from "../providers/registry.js";
import { resolveUsageRoot } from "../utils/usage-root.js";
import type {
  FoundSession,
  ProviderName,
  SessionProvider,
} from "../types/provider.js";

const PREFLIGHT_CONCURRENCY = 8;

export interface SyncOptions {
  quiet?: boolean;
}

export interface SyncCommandDependencies {
  providers?: SessionProvider[];
}

interface SyncCandidate {
  found: FoundSession;
  sourceFingerprint: string;
}

interface SyncPreflightFailure {
  failure: string;
}

/** Reconcile every provider transcript into idempotent per-session shards. */
export class SyncCommand {
  private configManager = new ConfigManager();
  private writer = new LogbookWriter();
  private providers?: SessionProvider[];

  constructor(dependencies: SyncCommandDependencies = {}) {
    this.providers = dependencies.providers;
  }

  async execute(options: SyncOptions = {}): Promise<number> {
    const spinner = ora({
      text: "Reconciling agent sessions...",
      isSilent: !!options.quiet,
    }).start();
    const config = await this.configManager.loadConfig();
    const { root } = resolveUsageRoot(config);
    // Before fingerprinting: preflight compares shard fingerprints against the
    // active pricing snapshot, so the snapshot must be loaded first.
    await initializePricingFeed(root);
    const providers = this.providers ?? allProviders(config);
    let updated = 0;
    const failures: string[] = [];

    for (const provider of providers) {
      const sessions = await provider.findAllSessions();
      const preflight = await mapConcurrent(
        sessions,
        PREFLIGHT_CONCURRENCY,
        async (found): Promise<SyncCandidate | SyncPreflightFailure | null> => {
          try {
            const shardPath = join(
              root,
              LOGBOOK_SHARD_DIR,
              `${found.sessionId}.json`,
            );
            const sourceFingerprint = await provider.fingerprintSession(found);
            if (
              !(await this.needsSync(
                sourceFingerprint,
                shardPath,
                provider.name,
              ))
            ) {
              return null;
            }
            return { found, sourceFingerprint };
          } catch (error) {
            return {
              failure: this.formatFailure(provider, found, error),
            };
          }
        },
      );

      for (const result of preflight) {
        if (!result) continue;
        if ("failure" in result) {
          failures.push(result.failure);
          continue;
        }

        const { found, sourceFingerprint } = result;
        try {
          const snapshot = await provider.readSession(
            found.transcriptPath,
            found.sessionId,
          );
          let { sessionData } = snapshot;
          if (sessionData.sessionId !== found.sessionId) {
            throw new Error(
              `provider returned session ${sessionData.sessionId} for ${found.sessionId}`,
            );
          }
          if (sessionData.totalTokens <= 0) continue;
          if (!sessionData.sourceFingerprint) {
            sessionData = { ...sessionData, sourceFingerprint };
          }
          const { transcriptData } = snapshot;
          await this.writer.append(root, { sessionData, transcriptData });
          updated++;
        } catch (error) {
          failures.push(this.formatFailure(provider, found, error));
        }
      }
    }

    if (failures.length > 0) {
      spinner.fail("Failed to reconcile all agent records.");
      throw new Error(failures.join("\n"));
    }

    spinner.succeed(
      updated > 0
        ? `Reconciled ${updated} agent session${updated === 1 ? "" : "s"}.`
        : "Agent records are current.",
    );
    return updated;
  }

  private formatFailure(
    provider: SessionProvider,
    found: FoundSession,
    error: unknown,
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    return `${provider.name}:${found.sessionId}: ${message}`;
  }

  private async needsSync(
    sourceFingerprint: string,
    shardPath: string,
    provider: ProviderName,
  ): Promise<boolean> {
    if (!existsSync(shardPath)) return true;
    try {
      const content = await readFile(shardPath, "utf-8");
      const record = JSON.parse(content) as LogbookRecord;
      return (
        (record.provider || "claude") !== provider ||
        record.source_fingerprint !== sourceFingerprint
      );
    } catch {
      return true;
    }
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await map(items[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}
