export type SquirrelLifecycleEvent =
  | "--squirrel-install"
  | "--squirrel-updated"
  | "--squirrel-uninstall"
  | "--squirrel-obsolete";

const LIFECYCLE_EVENTS = new Set<SquirrelLifecycleEvent>([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

export function squirrelLifecycleEvent(
  platform: NodeJS.Platform,
  argv: readonly string[],
): SquirrelLifecycleEvent | null {
  if (platform !== "win32") return null;
  const event = argv[1] as SquirrelLifecycleEvent | undefined;
  return event && LIFECYCLE_EVENTS.has(event) ? event : null;
}
