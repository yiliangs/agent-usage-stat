import { open } from "fs/promises";
import { ClaudeProvider } from "./claude/provider.js";
import { CodexProvider } from "./codex/provider.js";
import { CopilotProvider } from "./copilot/provider.js";
import type {
  FoundSession,
  ProviderName,
  SessionProvider,
} from "../types/provider.js";
import type { AppConfig } from "../types/config.js";
import { homeDir } from "../utils/paths.js";
import { resolveProviderDataRoots } from "../utils/provider-data-roots.js";
import { isAbsolute, relative, resolve } from "node:path";

interface ProviderRegistration {
  name: ProviderName;
  create: (root?: string) => SessionProvider;
  transcriptRecordTypes: readonly string[];
}

const PROVIDERS: readonly ProviderRegistration[] = [
  {
    name: "claude",
    create: (root) => new ClaudeProvider(root),
    transcriptRecordTypes: ["user", "assistant"],
  },
  {
    name: "codex",
    create: (root) => new CodexProvider(root),
    transcriptRecordTypes: ["session_meta", "turn_context"],
  },
  {
    name: "copilot",
    create: (root) => new CopilotProvider(root),
    transcriptRecordTypes: ["session.start"],
  },
];

export interface ResolvedSession {
  provider: SessionProvider;
  found: FoundSession;
}

/** Create a provider explicitly for programmatic library use. */
export function providerByName(
  name: ProviderName,
  root?: string,
): SessionProvider {
  const registration = PROVIDERS.find((provider) => provider.name === name);
  if (!registration) {
    throw new Error(`Unsupported provider: ${String(name)}`);
  }
  return registration.create(root);
}

/** Every installed provider implementation, used by provider-neutral workflows. */
export function allProviders(
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): SessionProvider[] {
  const roots = resolveProviderDataRoots(config, environment, home);
  return roots.map((item) => providerByName(item.provider, item.root));
}

/** Detect a transcript by wire format, with path only as a final fallback. */
export async function detectProvider(
  transcriptPath: string,
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
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

  const root = resolveProviderDataRoots(config, environment, home).find((item) =>
    isPathInside(item.root, transcriptPath)
  );
  if (root) return providerByName(root.provider, root.root);
  throw new Error(`Could not detect transcript provider: ${transcriptPath}`);
}

/** Find the newest matching session across every provider store. */
export async function findSession(
  query?: string,
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): Promise<ResolvedSession> {
  const results = await Promise.all(
    allProviders(config, environment, home).map(async (provider) => {
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

function isPathInside(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
