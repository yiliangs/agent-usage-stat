import { normalizeModelId } from "./pricing.js";

/**
 * Human-readable display names for Claude model IDs, shared by the text and
 * HTML renderers. Keyed by the normalized
 * alias — normalizeModelId strips date suffixes ("-20251001") and context
 * variant suffixes ("[1m]") so every shape of the same model resolves here.
 *
 * Keep this list in sync with Claude pricing.ts and the shared GPT rates it
 * resolves through providers/codex/pricing.ts.
 */
const DISPLAY_NAMES: Record<string, string> = {
  // GPT models routed through Claude Code
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.5-pro": "GPT-5.5 Pro",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.4-nano": "GPT-5.4 Nano",
  "gpt-5.4-pro": "GPT-5.4 Pro",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",

  // Current Claude generation (July 2026)
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  // Prior generation
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-opus-4-0": "Claude Opus 4",
  "claude-opus-4": "Claude Opus 4",
  "claude-sonnet-4-0": "Claude Sonnet 4",
  "claude-sonnet-4": "Claude Sonnet 4",
  // Legacy
  "claude-3-7-sonnet": "Claude 3.7 Sonnet",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
  "claude-3-5-haiku": "Claude 3.5 Haiku",
  "claude-3-opus": "Claude 3 Opus",
  "claude-3-haiku": "Claude 3 Haiku",
};

const VENDORS: Record<string, string> = { claude: "Claude", gpt: "GPT" };
const FAMILIES = new Set([
  "opus", "sonnet", "haiku", "fable", "sol", "terra", "luna",
  "mini", "nano", "pro", "codex",
]);

/**
 * Build a label for a model this table has never heard of.
 *
 * The table is curated and stays authoritative, but it only changes when
 * somebody remembers to edit it, and nothing ties it to pricing.ts. A model
 * released between edits used to render as its raw id. Deriving the obvious
 * label from the id shape keeps a new release readable without an edit, and
 * returns the id unchanged when the shape is not recognisable.
 */
export function deriveDisplayName(normalized: string): string | undefined {
  const parts = normalized.split("-").filter(Boolean);
  const vendor = VENDORS[parts[0]];
  if (!vendor || parts.length < 2) return undefined;

  const words: string[] = [vendor];
  let version: string[] = [];
  for (const part of parts.slice(1)) {
    if (/^\d+$/.test(part)) {
      version.push(part);
      continue;
    }
    if (version.length) {
      words.push(version.join("."));
      version = [];
    }
    if (!FAMILIES.has(part)) return undefined;
    words.push(part[0].toUpperCase() + part.slice(1));
  }
  if (version.length) words.push(version.join("."));
  return words.length > 1 ? words.join(" ") : undefined;
}

export function displayModelName(model: string): string {
  const normalized = normalizeModelId(model);
  return DISPLAY_NAMES[normalized] || deriveDisplayName(normalized) || model;
}
