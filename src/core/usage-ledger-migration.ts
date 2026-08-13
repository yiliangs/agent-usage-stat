import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  LOGBOOK_SHARD_DIR,
  type LogbookRecord,
} from "./usage-ledger.js";

export interface LedgerMergeResult {
  copied: number;
  retained: number;
}

/** Merge source shards into a destination without replacing stronger records. */
export async function mergeUsageLedger(
  sourceRoot: string,
  destinationRoot: string,
): Promise<LedgerMergeResult> {
  if (sameUsageRoot(sourceRoot, destinationRoot)) {
    return { copied: 0, retained: 0 };
  }
  assertIndependentRoots(sourceRoot, destinationRoot);

  const sourceDir = join(sourceRoot, LOGBOOK_SHARD_DIR);
  if (!existsSync(sourceDir)) return { copied: 0, retained: 0 };

  const destinationDir = join(destinationRoot, LOGBOOK_SHARD_DIR);
  await mkdir(destinationDir, { recursive: true });

  let copied = 0;
  let retained = 0;
  const files = (await readdir(sourceDir))
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .sort();

  for (const file of files) {
    const source = await readRecord(join(sourceDir, file));
    const destinationPath = join(destinationDir, file);
    const destination = await readOptionalRecord(destinationPath);
    const record = destination
      ? recordForMigration(source, destination, file)
      : source;

    if (record === destination) {
      retained++;
      continue;
    }
    await writeRecordAtomic(destinationPath, record);
    copied++;
  }

  return { copied, retained };
}

export async function usageLedgerHasRecords(root: string): Promise<boolean> {
  const shardDir = join(root, LOGBOOK_SHARD_DIR);
  if (!existsSync(shardDir)) return false;
  return (await readdir(shardDir)).some((file) =>
    file.toLowerCase().endsWith(".json")
  );
}

export function sameUsageRoot(left: string, right: string): boolean {
  const normalize = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

/** Remove only the application-owned shard directory after verified migration. */
export async function removeUsageLedger(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const shardDir = resolve(resolvedRoot, LOGBOOK_SHARD_DIR);
  if (dirname(shardDir) !== resolvedRoot) {
    throw new Error(`Refusing to remove ledger outside ${resolvedRoot}`);
  }
  await rm(shardDir, { recursive: true, force: true });
}

function recordForMigration(
  source: LogbookRecord,
  destination: LogbookRecord,
  file: string,
): LogbookRecord {
  if (
    source.session_id !== destination.session_id ||
    (source.provider || "claude") !== (destination.provider || "claude")
  ) {
    throw new Error(`Conflicting usage ledger shard: ${file}`);
  }

  const sourceRegresses =
    number(source.total_tokens) < number(destination.total_tokens) ||
    number(source.total_cost_usd) < number(destination.total_cost_usd);
  return sourceRegresses ? destination : source;
}

async function readRecord(path: string): Promise<LogbookRecord> {
  const record = JSON.parse(await readFile(path, "utf8")) as LogbookRecord;
  if (!record.session_id) throw new Error(`Invalid usage ledger shard: ${path}`);
  return record;
}

async function readOptionalRecord(path: string): Promise<LogbookRecord | null> {
  if (!existsSync(path)) return null;
  return readRecord(path);
}

async function writeRecordAtomic(
  path: string,
  record: LogbookRecord,
): Promise<void> {
  const staged = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(staged, JSON.stringify(record, null, 2), "utf8");
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertIndependentRoots(left: string, right: string): void {
  if (isInside(left, right) || isInside(right, left)) {
    throw new Error("Usage ledger folders cannot contain one another.");
  }
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent !== "" &&
    !fromParent.startsWith("..") &&
    !isAbsolute(fromParent);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
