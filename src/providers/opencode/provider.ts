import type {
  FoundSession,
  ProviderSessionSnapshot,
  SessionProvider,
} from "../../types/provider.js";
import { SessionFinder } from "./session-finder.js";
import { readOpencodeSnapshot } from "./session-reader.js";
import { fingerprintSessionTree } from "./transcript-fingerprint.js";

export class OpencodeProvider implements SessionProvider {
  readonly name = "opencode" as const;

  private finder: SessionFinder;

  constructor(dataRoot?: string) {
    this.finder = new SessionFinder(dataRoot);
  }

  findSession(query?: string): Promise<FoundSession> {
    return this.finder.find(query);
  }

  findAllSessions(): Promise<FoundSession[]> {
    return this.finder.findAll();
  }

  fingerprintSession(session: FoundSession): Promise<string> {
    return fingerprintSessionTree(session.transcriptPath, session.sessionId);
  }

  /**
   * `transcriptPath` is the opencode database and `fallbackSessionId` selects
   * the session inside it — one database holds every session, so unlike the
   * file-per-session hosts the id is not a fallback here but the key.
   */
  readSession(
    transcriptPath: string,
    fallbackSessionId: string,
  ): Promise<ProviderSessionSnapshot> {
    return readOpencodeSnapshot(transcriptPath, fallbackSessionId);
  }
}
