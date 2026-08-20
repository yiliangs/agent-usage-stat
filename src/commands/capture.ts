import { stdin } from "process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { unlink } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import ora from "ora";
import { logHookEvent } from "../utils/hook-log.js";
import { expandHome } from "../utils/paths.js";
import {
  correlatedCaptureFromInput,
  publishCaptureOutcome,
} from "../utils/capture-run.js";
import {
  detectProvider,
  findSession,
} from "../providers/registry.js";
import { ConfigManager } from "../core/config-manager.js";
import { LogbookWriter } from "../core/logbook-writer.js";
import { initializePricingFeed } from "../core/pricing-feed.js";
import { resolveUsageRoot } from "../utils/usage-root.js";
import type { HookData } from "../types/session-hook.js";
import type { SessionProvider } from "../types/provider.js";
import type { CaptureOutcome } from "../utils/capture-run.js";
import { recordCaptureHealth } from "../utils/capture-health.js";

const execFileAsync = promisify(execFile);

export interface CaptureOptions {
  session?: string;
  detach?: boolean;
  inputFile?: string;
  quiet?: boolean;
}

export class CaptureCommand {
  private configManager = new ConfigManager();
  private logbookWriter = new LogbookWriter();

  async execute(options: CaptureOptions): Promise<void> {
    const spinner = ora({
      text: "Recording usage...",
      isSilent: !!options.quiet,
    }).start();
    logHookEvent(`invoke pid=${process.pid} cwd=${process.cwd()}`);

    let hookData: HookData | null = null;
    let provider: SessionProvider | undefined;
    let sessionId: string | undefined;
    let outcome: CaptureOutcome | undefined;

    try {
      hookData = options.inputFile
        ? this.readInputFile(options.inputFile)
        : await this.readStdinIfAvailable();
      let transcriptPath: string | undefined;

      if (hookData) {
        transcriptPath =
          hookData.hook_event_name === "SubagentStop"
            ? hookData.agent_transcript_path || hookData.transcript_path || undefined
            : hookData.transcript_path || undefined;
        sessionId = hookData.session_id;
        logHookEvent(
          `hook session=${sessionId} event=${hookData.hook_event_name} transcript=${transcriptPath}`,
        );
      }

      const config = await this.configManager.loadConfig();
      const { root, source } = resolveUsageRoot(config);
      logHookEvent(`data root ${root} (${source})`);
      // Before any pricing or fingerprint work; the worker is detached, so a
      // stale-feed refresh may spend its bounded fetch timeout here unseen.
      await initializePricingFeed(root);

      if (transcriptPath) {
        // The agent itself named this path in its hook payload, so its absence
        // means the session never wrote a transcript: an empty session, not a
        // capture failure. Agents emit end-of-session hooks for turnless
        // sessions routinely, and recording those as failures poisons the
        // capture health record while nothing is lost.
        if (hookData && !existsSync(resolve(expandHome(transcriptPath)))) {
          outcome = { status: "no_usage", reason: "transcript_missing" };
          provider = await detectProvider(transcriptPath, config).catch(() => undefined);
          await this.recordHookHealth(hookData, provider, outcome);
          spinner.info("No transcript was written for this session.");
          logHookEvent(`skip missing-transcript session=${sessionId ?? "?"}`);
          return;
        }
        provider = await detectProvider(transcriptPath, config);
      } else {
        const resolved = await findSession(options.session ?? sessionId, config);
        provider = resolved.provider;
        transcriptPath = resolved.found.transcriptPath;
        sessionId = resolved.found.sessionId;
        logHookEvent(
          `manual provider=${provider.name} session=${sessionId} transcript=${transcriptPath}`,
        );
      }

      spinner.text = "Computing usage...";
      const snapshot = await provider.readSession(
        transcriptPath,
        sessionId ?? "",
      );
      const { sessionData, unknownModels } = snapshot;
      let { transcriptData } = snapshot;
      sessionId = sessionData.sessionId || sessionId;

      if (unknownModels.length > 0) {
        logHookEvent(
          `pricing miss provider=${provider.name} models=${unknownModels.join(",")} billed at $0`,
        );
      }

      if (sessionData.totalTokens <= 0) {
        outcome = { status: "no_usage", reason: "zero_tokens" };
        await this.recordHookHealth(hookData, provider, outcome);
        spinner.info("No token usage to record.");
        logHookEvent(`skip zero-token session=${sessionId ?? "?"}`);
        return;
      }

      spinner.text = "Reading session metadata...";
      const cwd = hookData?.cwd || transcriptData.cwd;
      if (cwd && (!transcriptData.gitBranch || transcriptData.gitBranch === "HEAD")) {
        const branch = await this.resolveCurrentBranch(cwd);
        if (branch) transcriptData = { ...transcriptData, gitBranch: branch };
      }

      const shardPath = await this.logbookWriter.append(root, {
        sessionData,
        transcriptData,
      });
      outcome = {
        status: "recorded",
        project: transcriptData.projectName || "",
        total_tokens: sessionData.totalTokens,
        total_cost_usd: Number(sessionData.totalCost.toFixed(6)),
        shard_path: shardPath,
      };
      await this.recordHookHealth(hookData, provider, outcome);
      logHookEvent(
        `done provider=${provider.name} tokens=${sessionData.totalTokens} cost=${sessionData.totalCost.toFixed(6)} shard=${shardPath}`,
      );
      spinner.succeed("Usage recorded.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      outcome = { status: "failed", message };
      await this.recordHookHealth(hookData, provider, outcome);
      spinner.fail("Failed to record usage.");
      logHookEvent(`fatal: ${message}`);
      if (!options.quiet) console.error(chalk.red(`Error: ${message}`));
      process.exitCode = 1;
    } finally {
      if (options.inputFile) {
        await this.finishInputFile(options.inputFile, outcome, {
          hookEventName: hookData?.hook_event_name,
          provider: provider?.name,
          sessionId,
        });
      }
    }
  }

  private async resolveCurrentBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "branch", "--show-current"],
        { timeout: 1500, windowsHide: true },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private readInputFile(path: string): HookData {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as HookData;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logHookEvent(`input-file read failed (${path}): ${message}`);
      throw new Error(`Failed to read hook input: ${message}`);
    }
  }

  private async finishInputFile(
    path: string,
    outcome: CaptureOutcome | undefined,
    details: {
      hookEventName?: string;
      provider?: SessionProvider["name"];
      sessionId?: string;
    },
  ): Promise<void> {
    const correlated = correlatedCaptureFromInput(path);
    if (!correlated) {
      await this.removeInputFile(path);
      return;
    }
    if (!outcome) return;

    try {
      const published = await publishCaptureOutcome(path, outcome, details);
      if (!published) return;
      await this.removeInputFile(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logHookEvent(
        `result publish failed run=${correlated.runId} capture=${correlated.captureId}: ${message}`,
      );
    }
  }

  private async removeInputFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Best-effort cleanup. A matching result still resolves correlated work.
    }
  }

  private async recordHookHealth(
    hookData: HookData | null,
    provider: SessionProvider | undefined,
    outcome: CaptureOutcome,
  ): Promise<void> {
    if (!hookData?.hook_event_name || !provider) return;
    try {
      await recordCaptureHealth({
        provider: provider.name,
        hookEventName: hookData.hook_event_name,
        status: outcome.status,
        ...(outcome.status === "failed" ? { message: outcome.message } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logHookEvent(`health update failed provider=${provider.name}: ${message}`);
    }
  }

  private async readStdinIfAvailable(): Promise<HookData | null> {
    return new Promise((resolve) => {
      if (stdin.isTTY) {
        resolve(null);
        return;
      }

      let data = "";
      const timeout = setTimeout(() => resolve(null), 2000);
      stdin.setEncoding("utf-8");
      stdin.on("data", (chunk) => {
        data += chunk;
      });
      stdin.on("end", () => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(data) as HookData);
        } catch {
          resolve(null);
        }
      });
      stdin.resume();
    });
  }
}
