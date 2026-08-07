import { open } from "fs/promises";
import { ClaudeProvider } from "./claude/provider.js";
import { CodexProvider } from "./codex/provider.js";
import { CopilotProvider } from "./copilot/provider.js";
import type {
  FoundSession,
  ProviderName,
  SessionProvider,
} from "../types/provider.js";

interface ProviderRegistration {
  name: ProviderName;
  create: () => SessionProvider;
  transcriptRecordTypes: readonly string[];
  homePathSegment: string;
}

const PROVIDERS: readonly ProviderRegistration[] = [
  {
    name: "claude",
    create: () => new ClaudeProvider(),
    transcriptRecordTypes: ["user", "assistant"],
    homePathSegment: "/.claude/",
  },
  {
    name: "codex",
    create: () => new CodexProvider(),
    transcriptRecordTypes: ["session_meta", "turn_context"],
    homePathSegment: "/.codex/",
  },
  {
    name: "copilot",
    create: () => new CopilotProvider(),
    transcriptRecordTypes: ["session.start"],
    homePathSegment: "/.copilot/",
  },
];

export interface ResolvedSession {
  provider: SessionProvider;
  found: FoundSession;
}

/** Create a provider explicitly for programmatic library use. */
export function providerByName(name: ProviderName): SessionProvider {
  const registration = PROVIDERS.find((provider) => provider.name === name);
  if (!registration) {
    throw new Error(`Unsupported provider: ${String(name)}`);
  }
  return registration.create();
}

/** Every installed provider implementation, used by provider-neutral workflows. */
export function allProviders(): SessionProvider[] {
  return PROVIDERS.map((provider) => provider.create());
}

/** Detect a transcript by wire format, with path only as a final fallback. */
export async function detectProvider(
  transcriptPath: string,
): Promise<SessionProvider> {
  let head = "";
  try {
    const handle = await open(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(131_072);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.toString("utf-8", 0, result.bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    // Let the selected provider surface the useful missing-file error later.
  }

  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { type?: string };
      const registration = PROVIDERS.find((provider) =>
        record.type
          ? provider.transcriptRecordTypes.includes(record.type)
          : false,
      );
      if (registration) return registration.create();
    } catch {
      // Keep scanning; a partial final line can appear in the head chunk.
    }
  }

  const normalized = transcriptPath.replace(/\\/g, "/").toLowerCase();
  const registration = PROVIDERS.find((provider) =>
    normalized.includes(provider.homePathSegment),
  );
  if (registration) return registration.create();
  throw new Error(`Could not detect transcript provider: ${transcriptPath}`);
}

/** Find the newest matching session across every provider store. */
export async function findSession(
  query?: string,
): Promise<ResolvedSession> {
  const results = await Promise.all(
    allProviders().map(async (provider) => {
      try {
        return { provider, found: await provider.findSession(query) };
      } catch {
        return null;
      }
    }),
  );
  const matches = results.filter((x): x is ResolvedSession => x !== null);
  if (matches.length === 0) {
    throw new Error(
      query
        ? `No Claude Code, Codex, or Copilot session matching "${query}".`
        : "No Claude Code, Codex, or Copilot sessions found.",
    );
  }
  matches.sort((a, b) => b.found.mtimeMs - a.found.mtimeMs);
  return matches[0];
}
