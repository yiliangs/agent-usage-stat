import { existsSync } from "fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { randomBytes, randomUUID } from "crypto";
import { basename, join, relative, resolve } from "path";
import { homeDir, homeDirFrom } from "./paths.js";
import type { ProviderName } from "../types/provider.js";

const SCHEMA_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const RUNS_DIR = "runs";
const PENDING_DIR = "pending";
const RESULTS_DIR = "results";

export type AgentCommandName = ProviderName | "claudex";

export interface AgentRunManifest {
  schema_version: 1;
  run_id: string;
  agent: AgentCommandName;
  started_at: string;
  wrapper_pid: number;
}

interface CaptureResultBase {
  schema_version: 1;
  run_id: string;
  capture_id: string;
  completed_at: string;
  hook_event_name?: string;
  provider?: ProviderName;
  session_id?: string;
}

export interface RecordedCaptureResult extends CaptureResultBase {
  status: "recorded";
  project: string;
  total_tokens: number;
  total_cost_usd: number;
  shard_path: string;
}

export interface NoUsageCaptureResult extends CaptureResultBase {
  status: "no_usage";
  reason: "zero_tokens" | "transcript_missing";
}

export interface FailedCaptureResult extends CaptureResultBase {
  status: "failed";
  message: string;
}

export type CaptureResult =
  | RecordedCaptureResult
  | NoUsageCaptureResult
  | FailedCaptureResult;

export type CaptureOutcome =
  | Omit<RecordedCaptureResult, keyof CaptureResultBase>
  | Omit<NoUsageCaptureResult, keyof CaptureResultBase>
  | Omit<FailedCaptureResult, keyof CaptureResultBase>;

export interface AgentRun {
  manifest: AgentRunManifest;
  path: string;
  pendingPath: string;
  resultsPath: string;
}

export interface CorrelatedCapture {
  runId: string;
  captureId: string;
  inputPath: string;
  resultPath: string;
}

export interface RunSnapshot {
  results: CaptureResult[];
  pendingCaptureIds: string[];
  unresolvedCaptureIds: string[];
  signature: string;
}

export interface SettledRun extends RunSnapshot {
  timedOut: boolean;
}

export interface WaitForRunOptions {
  pollMs?: number;
  quietMs?: number;
  timeoutMs?: number;
}

export function captureRunsRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const home = homeDirFrom(environment) || homeDir();
  return join(home, ".agent-usage-stat", RUNS_DIR);
}

export function isSafeCaptureId(value: string | undefined): value is string {
  return !!value && SAFE_ID.test(value);
}

export async function createAgentRun(
  agent: AgentCommandName,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentRun> {
  const runId = randomUUID();
  const path = join(captureRunsRoot(environment), runId);
  const pendingPath = join(path, PENDING_DIR);
  const resultsPath = join(path, RESULTS_DIR);
  const manifest: AgentRunManifest = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    agent,
    started_at: new Date().toISOString(),
    wrapper_pid: process.pid,
  };

  await mkdir(pendingPath, { recursive: true, mode: 0o700 });
  await mkdir(resultsPath, { recursive: true, mode: 0o700 });
  await writeFile(
    join(path, "run.json"),
    JSON.stringify(manifest, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );

  return { manifest, path, pendingPath, resultsPath };
}

export function createCorrelatedInputPath(
  runId: string | undefined,
  captureId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isSafeCaptureId(runId) || !isSafeCaptureId(captureId)) return null;

  const pendingPath = join(captureRunsRoot(environment), runId, PENDING_DIR);
  if (!existsSync(pendingPath)) return null;

  return join(pendingPath, `${captureId}.json`);
}

export function correlatedCaptureFromInput(
  inputPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): CorrelatedCapture | null {
  const runsRoot = resolve(captureRunsRoot(environment));
  const absolute = resolve(inputPath);
  const parts = relative(runsRoot, absolute).split(/[\\/]/);
  if (parts.length !== 3 || parts[1] !== PENDING_DIR) return null;

  const runId = parts[0];
  const file = parts[2];
  if (!file.endsWith(".json")) return null;

  const captureId = basename(file, ".json");
  if (!isSafeCaptureId(runId) || !isSafeCaptureId(captureId)) return null;

  return {
    runId,
    captureId,
    inputPath: absolute,
    resultPath: join(runsRoot, runId, RESULTS_DIR, `${captureId}.json`),
  };
}

export async function publishCaptureOutcome(
  inputPath: string,
  outcome: CaptureOutcome,
  details: {
    hookEventName?: string;
    provider?: ProviderName;
    sessionId?: string;
  } = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const capture = correlatedCaptureFromInput(inputPath, environment);
  if (!capture) return false;

  const result: CaptureResult = {
    schema_version: SCHEMA_VERSION,
    run_id: capture.runId,
    capture_id: capture.captureId,
    completed_at: new Date().toISOString(),
    hook_event_name: details.hookEventName,
    provider: details.provider,
    session_id: details.sessionId,
    ...outcome,
  } as CaptureResult;
  const tempPath = `${capture.resultPath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;

  await writeFile(tempPath, JSON.stringify(result, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tempPath, capture.resultPath);
  return true;
}

export async function waitForAgentRun(
  run: AgentRun,
  options: WaitForRunOptions = {},
): Promise<SettledRun> {
  const pollMs = options.pollMs ?? 100;
  const quietMs = options.quietMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let stableSince = Date.now();
  let previousSignature: string | null = null;
  let snapshot = await readRunSnapshot(run);

  while (true) {
    const now = Date.now();
    if (snapshot.signature !== previousSignature) {
      previousSignature = snapshot.signature;
      stableSince = now;
    }

    if (
      snapshot.unresolvedCaptureIds.length === 0 &&
      now - stableSince >= quietMs
    ) {
      return { ...snapshot, timedOut: false };
    }

    if (now >= deadline) {
      return { ...snapshot, timedOut: true };
    }

    await delay(Math.min(pollMs, Math.max(1, deadline - now)));
    snapshot = await readRunSnapshot(run);
  }
}

export async function readRunSnapshot(run: AgentRun): Promise<RunSnapshot> {
  const pendingFiles = await readJsonNames(run.pendingPath);
  const resultFiles = await readJsonNames(run.resultsPath);
  const results: CaptureResult[] = [];

  for (const file of resultFiles) {
    try {
      const parsed = JSON.parse(
        await readFile(join(run.resultsPath, file), "utf-8"),
      ) as unknown;
      if (isCaptureResult(parsed, run.manifest.run_id)) results.push(parsed);
    } catch {
      // Atomic publication should make this rare. Ignore incomplete/corrupt data.
    }
  }

  const pendingCaptureIds = pendingFiles.map((file) => basename(file, ".json"));
  const completed = new Set(results.map((result) => result.capture_id));
  const unresolvedCaptureIds = pendingCaptureIds.filter(
    (captureId) => !completed.has(captureId),
  );
  const signature = [
    ...pendingFiles.map((file) => `p:${file}`),
    ...resultFiles.map((file) => `r:${file}`),
  ]
    .sort()
    .join("|");

  return {
    results,
    pendingCaptureIds,
    unresolvedCaptureIds,
    signature,
  };
}

export async function removeAgentRun(run: AgentRun): Promise<void> {
  await rm(run.path, { recursive: true, force: true });
}

export async function pruneExpiredRuns(
  environment: NodeJS.ProcessEnv = process.env,
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  const root = captureRunsRoot(environment);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    names.map(async (name) => {
      if (!isSafeCaptureId(name)) return;
      const path = join(root, name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // Another process may be creating or pruning the same run.
      }
    }),
  );
}

function isCaptureResult(
  value: unknown,
  expectedRunId: string,
): value is CaptureResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<CaptureResult>;
  if (
    result.schema_version !== SCHEMA_VERSION ||
    result.run_id !== expectedRunId ||
    !isSafeCaptureId(result.capture_id) ||
    typeof result.completed_at !== "string"
  ) {
    return false;
  }

  switch (result.status) {
    case "recorded":
      return (
        typeof result.project === "string" &&
        typeof result.total_tokens === "number" &&
        typeof result.total_cost_usd === "number" &&
        Number.isFinite(result.total_cost_usd) &&
        result.total_cost_usd >= 0 &&
        typeof result.shard_path === "string"
      );
    case "no_usage":
      return result.reason === "zero_tokens" ||
        result.reason === "transcript_missing";
    case "failed":
      return typeof result.message === "string";
    default:
      return false;
  }
}

async function readJsonNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
