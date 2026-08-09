import { UsageCalculator } from "./usage-calculator.js";
import { TranscriptParser } from "./transcript-parser.js";
import { SessionFinder } from "./session-finder.js";
import { fingerprintTranscriptFile } from "./transcript-fingerprint.js";
import type {
  FoundSession,
  SessionProvider,
} from "../../types/provider.js";
import type { SessionUsage } from "../../types/session.js";
import type { ParsedTranscript } from "../../types/transcript.js";

/** Codex rollouts under ~/.codex/sessions, priced at OpenAI API list rates. */
export class CodexProvider implements SessionProvider {
  readonly name = "codex" as const;

  private calculator = new UsageCalculator();
  private parser = new TranscriptParser();
  private finder: SessionFinder;

  constructor(codexHome?: string) {
    this.finder = new SessionFinder(codexHome);
  }

  findSession(query?: string): Promise<FoundSession> {
    return this.finder.find(query);
  }

  findAllSessions(): Promise<FoundSession[]> {
    return this.finder.findAll();
  }

  fingerprintSession(session: FoundSession): Promise<string> {
    return fingerprintTranscriptFile(session.transcriptPath);
  }

  calculateUsage(
    transcriptPath: string,
    sessionId: string,
  ): Promise<SessionUsage> {
    return this.calculator.calculate(transcriptPath, sessionId);
  }

  getUnknownModels(): string[] {
    return this.calculator.getUnknownModels();
  }

  parseTranscript(
    transcriptPath: string,
    fallbackId?: string,
  ): Promise<ParsedTranscript> {
    return this.parser.parseTranscript(transcriptPath, fallbackId);
  }
}
