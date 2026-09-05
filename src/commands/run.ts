import crossSpawn from "cross-spawn";
import { PROVIDER_NAMES } from "../core/provider-definition.js";
import {
  createAgentRun,
  pruneExpiredRuns,
  removeAgentRun,
  waitForAgentRun,
} from "../utils/capture-run.js";
import type {
  AgentCommandName,
  AgentRun,
  RecordedCaptureResult,
  SettledRun,
} from "../utils/capture-run.js";

const AGENTS = new Set<AgentCommandName>([...PROVIDER_NAMES, "claudex"]);

interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class RunCommand {
  async execute(agentValue: string, args: string[]): Promise<number> {
    const agent = this.parseAgent(agentValue);
    await pruneExpiredRuns().catch(() => undefined);
    // The run directory is the terminal feedback channel, not a precondition
    // for launching. When it cannot be created the agent still runs, without
    // correlation, and the detach shim falls back to its tmpdir path.
    const run = await createAgentRun(agent).catch(() => undefined);
    let agentExit: AgentExit;

    try {
      agentExit = await this.launchAgent(agent, args, run?.manifest.run_id);
    } catch (error) {
      if (run) await removeAgentRun(run).catch(() => undefined);
      throw error;
    }

    if (run) await this.reportRun(run);

    return this.exitCode(agentExit);
  }

  private async reportRun(run: AgentRun): Promise<void> {
    try {
      const settled = await waitForAgentRun(run);
      const message = formatRunMessage(settled);
      if (message) process.stderr.write(`${message}\n`);
      if (!settled.timedOut && settled.unresolvedCaptureIds.length === 0) {
        await removeAgentRun(run).catch(() => undefined);
      }
    } catch {
      process.stderr.write(
        "[Agent Usage Stat] Usage recording status could not be verified.\n",
      );
    }
  }

  private parseAgent(value: string): AgentCommandName {
    if (AGENTS.has(value as AgentCommandName)) {
      return value as AgentCommandName;
    }
    throw new Error(
      `Unsupported agent: ${value}. Choose claude, codex, copilot, opencode, or claudex.`,
    );
  }

  private launchAgent(
    agent: AgentCommandName,
    args: string[],
    runId: string | undefined,
  ): Promise<AgentExit> {
    const env = { ...process.env };
    // Without a run of our own the child must carry no correlation at all. An
    // inherited id would publish this session's captures into someone else's
    // run directory.
    if (runId) env.AGENT_USAGE_STAT_RUN_ID = runId;
    else delete env.AGENT_USAGE_STAT_RUN_ID;

    return new Promise((resolve, reject) => {
      const child = crossSpawn(agent, args, {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
        windowsHide: true,
      });
      const holdSignal = (): void => undefined;
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
      const cleanup = (): void => {
        for (const signal of signals) process.removeListener(signal, holdSignal);
      };

      for (const signal of signals) process.on(signal, holdSignal);
      child.once("error", (error) => {
        cleanup();
        reject(new Error(`Failed to launch ${agent}: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        cleanup();
        resolve({ code, signal });
      });
    });
  }

  private exitCode(result: AgentExit): number {
    if (result.code !== null) return result.code;
    if (result.signal === "SIGINT") return 130;
    if (result.signal === "SIGTERM") return 143;
    return 1;
  }
}

export function formatRunMessage(run: SettledRun): string | null {
  const recorded = run.results
    .filter((result): result is RecordedCaptureResult => result.status === "recorded")
    .sort((left, right) => left.completed_at.localeCompare(right.completed_at));
  const failed = run.results.filter((result) => result.status === "failed");
  const noUsage = run.results.filter((result) => result.status === "no_usage");
  const unresolved = run.unresolvedCaptureIds.length > 0 || run.timedOut;

  if (recorded.length > 0) {
    if (failed.length > 0) {
      return "[Agent Usage Stat] Usage recorded, but another update failed.";
    }
    if (unresolved) {
      return "[Agent Usage Stat] Usage recorded, but another update could not be verified before timeout.";
    }

    const latest = recorded[recorded.length - 1];
    const provider = latest.provider
      ? latest.provider[0].toUpperCase() + latest.provider.slice(1)
      : "Agent";
    const project = latest.project ? `, ${latest.project}` : "";
    return `[Agent Usage Stat] Usage recorded: ${provider}, ${formatTokens(latest.total_tokens)} tokens, ${formatUsd(latest.total_cost_usd)}${project}`;
  }

  if (failed.length > 0) {
    return "[Agent Usage Stat] Failed to record usage.";
  }
  if (unresolved) {
    return "[Agent Usage Stat] Usage recording did not finish before the status wait ended.";
  }
  if (noUsage.length > 0) {
    return "[Agent Usage Stat] No token usage to record.";
  }
  return null;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimDecimal(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimDecimal(tokens / 1_000)}K`;
  return Math.max(0, Math.round(tokens)).toLocaleString("en-US");
}

function formatUsd(cost: number): string {
  return `$${cost.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, "");
}
