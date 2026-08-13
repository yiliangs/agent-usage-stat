// The provider seam.
//
// Everything upstream of SessionUsage/ParsedTranscript is provider-specific:
// where sessions live on disk, the transcript wire format, how billing events
// are summed, and the price table. Everything downstream, including the
// shard writer and portal consumes only the normalized shapes and
// must stay provider-neutral. A new provider is a new directory
// under src/providers/ implementing this interface; nothing downstream
// changes except reading the `provider` discriminator.
//
// Deliberately NOT abstracted here: host hook triggers (detach shim,
// setup). Hook wiring is per-host-tool by nature and the shim must stay
// builtins-only — provider dispatch happens in the worker, never the shim.

import type { SessionUsage, ProviderName } from "./session.js";
import type { ParsedTranscript } from "./transcript.js";

export type { ProviderName };

/** A session located on disk (manual-mode discovery). */
export interface FoundSession {
  sessionId: string;
  transcriptPath: string;
  projectPath: string;
  mtimeMs: number;
}

/** One internally consistent view of a provider transcript at read time. */
export interface ProviderSessionSnapshot {
  readonly sessionData: SessionUsage;
  readonly transcriptData: ParsedTranscript;
  readonly unknownModels: readonly string[];
}

export interface SessionProvider {
  /** Discriminator persisted to the logbook shard via SessionUsage. */
  readonly name: ProviderName;

  /**
   * Manual-mode discovery: locate a session by id prefix, or the most
   * recently modified session when no query is given.
   */
  findSession(query?: string): Promise<FoundSession>;

  /** List every top-level transcript candidate available for reconciliation. */
  findAllSessions(): Promise<FoundSession[]>;

  /** Cheap provider-specific fingerprint of every billing input for a session. */
  fingerprintSession(session: FoundSession): Promise<string>;

  /** Derive billing, metadata, and pricing misses from one transcript read. */
  readSession(
    transcriptPath: string,
    fallbackSessionId: string,
  ): Promise<ProviderSessionSnapshot>;
}
