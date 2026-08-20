/**
 * The single owner of project attribution for a session's working directory.
 *
 * A session run inside a git worktree still belongs to the project the
 * worktree was cut from, so the last path segment is not always the project.
 * Each agent CLI places its worktrees differently, which moves the project to
 * a different point in the path:
 *
 *   Claude Code   <project>/.claude/worktrees/<worktree>/...
 *   T3 Code       ~/.t3/worktrees/<project>/<worktree>/...
 *   Codex         ~/.codex/worktrees/<number>/<project>/...
 *
 * Codex names the checkout itself for the repository, so it needs no entry
 * below: its last segment is already the project. Register a tool here only
 * when its layout puts the project somewhere the last segment cannot reach.
 *
 * Paths are split on both separators rather than through `path`, because
 * shards written on Windows are read on macOS and the reverse.
 */

/** Where a worktree container keeps the project, relative to the container. */
type WorktreeLayout = "above" | "below";

const WORKTREE_DIR = "worktrees";

const WORKTREE_CONTAINERS: Record<string, WorktreeLayout> = {
  // The tool directory lives inside the checkout, so the project encloses it.
  ".claude": "above",
  // One machine-global store serves every repository, so it groups by project.
  ".t3": "below",
};

function segments(cwd: string | undefined): string[] {
  return (cwd || "").split(/[\\/]+/).filter(Boolean);
}

/**
 * The project owning a worktree checkout, or undefined when the path is not
 * inside a known worktree container. Undefined is not a failure: it means the
 * path says nothing about the project beyond its own last segment.
 */
export function worktreeProjectForCwd(
  cwd: string | undefined,
): string | undefined {
  const parts = segments(cwd);
  for (let index = parts.length - 1; index >= 1; index--) {
    if (parts[index].toLowerCase() !== WORKTREE_DIR) continue;
    const layout = WORKTREE_CONTAINERS[parts[index - 1].toLowerCase()];
    if (!layout) continue;
    return (layout === "above" ? parts[index - 2] : parts[index + 1]) ||
      undefined;
  }
  return undefined;
}

/** The project a session belongs to, given the directory it ran in. */
export function projectNameForCwd(cwd: string | undefined): string {
  const parts = segments(cwd);
  return worktreeProjectForCwd(cwd) ?? parts[parts.length - 1] ?? "";
}
