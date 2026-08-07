import type {
  FoundSession,
  SessionProvider,
} from "../../types/provider.js";
import type { SessionUsage } from "../../types/session.js";
import type { ParsedTranscript } from "../../types/transcript.js";
import { SessionFinder } from "./session-finder.js";
import { TranscriptParser } from "./transcript-parser.js";
import { UsageCalculator } from "./usage-calculator.js";
import { fingerprintTranscriptFile } from "./transcript-fingerprint.js";

export class CopilotProvider implements SessionProvider {
  readonly name = "copilot" as const;

  private calculator = new UsageCalculator();
  private parser = new TranscriptParser();
  private finder: SessionFinder;

  constructor(copilotHome?: string) {
    this.finder = new SessionFinder(copilotHome);
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

  calculateUsage(path: string, sessionId: string): Promise<SessionUsage> {
    return this.calculator.calculate(path, sessionId);
  }

  getUnknownModels(): string[] {
    return this.calculator.getUnknownModels();
  }

  parseTranscript(path: string, fallbackId?: string): Promise<ParsedTranscript> {
    return this.parser.parseTranscript(path, fallbackId);
  }
}
