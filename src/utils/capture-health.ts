import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import type { ProviderName } from "../types/provider.js";
import { homeDir, homeDirFrom } from "./paths.js";

export type HookCaptureStatus = "recorded" | "no_usage" | "failed";

export interface CaptureHealth {
  provider: ProviderName;
  lastAttemptAt: string;
  lastAttemptEvent: string;
  lastAttemptStatus: HookCaptureStatus;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureMessage?: string;
}

export interface CaptureHealthEvent {
  provider: ProviderName;
  hookEventName: string;
  status: HookCaptureStatus;
  message?: string;
  occurredAt?: string;
}

const LOCK_ATTEMPTS = 100;

export async function recordCaptureHealth(
  event: CaptureHealthEvent,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = captureHealthPath(event.provider, environment);
  await withLock(path, async () => {
    const previous = await readCaptureHealth(event.provider, environment);
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    if (previous && Date.parse(previous.lastAttemptAt) > Date.parse(occurredAt)) return;
    const success = event.status === "recorded" || event.status === "no_usage";
    const next: CaptureHealth = {
      provider: event.provider,
      lastAttemptAt: occurredAt,
      lastAttemptEvent: event.hookEventName,
      lastAttemptStatus: event.status,
      ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      ...(previous?.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
      ...(previous?.lastFailureMessage
        ? { lastFailureMessage: previous.lastFailureMessage }
        : {}),
    };
    if (success) next.lastSuccessAt = occurredAt;
    if (event.status === "failed") {
      next.lastFailureAt = occurredAt;
      next.lastFailureMessage = event.message || "Unknown hook capture failure";
    }
    await mkdir(join(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), "utf-8");
    await rename(temporary, path);
  });
}

export async function readCaptureHealth(
  provider: ProviderName,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CaptureHealth | null> {
  try {
    const parsed = JSON.parse(
      await readFile(captureHealthPath(provider, environment), "utf-8"),
    ) as CaptureHealth;
    return parsed.provider === provider && typeof parsed.lastAttemptAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function captureHealthPath(
  provider: ProviderName,
  environment: NodeJS.ProcessEnv,
): string {
  const root = homeDirFrom(environment) || homeDir();
  return join(root, ".agent-usage-stat", "capture-health", `${provider}.json`);
}

async function withLock(path: string, action: () => Promise<void>): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await unlink(lockPath);
      } catch {
        // Released between open and inspection.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  if (!handle) throw new Error(`timed out updating hook health: ${path}`);
  try {
    await action();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
