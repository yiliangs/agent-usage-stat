import type { SessionUsage } from "../../types/session.js";
import { readClaudeSnapshot } from "./incremental-snapshot.js";

/** Incrementally derive Claude billing from the append-only session tree. */
export class UsageCalculator {
  private unknownModels: string[] = [];

  async calculate(
    transcriptPath: string,
    fallbackSessionId: string,
  ): Promise<SessionUsage> {
    const snapshot = await readClaudeSnapshot(transcriptPath, fallbackSessionId);
    this.unknownModels = snapshot.unknownModels;
    return snapshot.sessionData;
  }

  getUnknownModels(): string[] {
    return [...this.unknownModels];
  }
}
