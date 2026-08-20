/**
 * Anthropic-style model IDs come in three flavors:
 *   - Alias:           "claude-opus-5"
 *   - Snapshot:        "claude-haiku-4-5-20251001"
 *   - Context variant: "claude-opus-5[1m]" (1M-context routing with the same
 *     standard pricing and no long-context premium)
 * Strip the bracket suffix first, then an 8-digit or ISO date suffix, so every
 * shape resolves to the same table entry. Without the bracket strip, [1m]
 * sessions fail the lookup and silently bill at $0.
 *
 * Shared by the provider pricing tables and the remote pricing feed so a feed
 * key and a transcript model ID normalize identically.
 */
export function normalizeModelId(model: string): string {
  return model
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}
