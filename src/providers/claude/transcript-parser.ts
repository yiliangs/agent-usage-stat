import type { ParsedTranscript } from "../../types/transcript.js";
import { readClaudeSnapshot } from "./incremental-snapshot.js";

/** Derive Claude metadata from the same incremental session snapshot. */
export class TranscriptParser {
  async parseTranscript(
    transcriptPath: string,
    fallbackId = "unknown-session",
  ): Promise<ParsedTranscript> {
    return (await readClaudeSnapshot(transcriptPath, fallbackId)).transcriptData;
  }
}
