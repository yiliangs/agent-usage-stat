/**
 * Collapse overlapping runs of one asynchronous operation into a single run.
 *
 * A caller arriving while a run is pending receives that run's promise rather
 * than starting its own. The first caller after it settles, whether it
 * resolved or rejected, starts a fresh run. This is the guard for work whose
 * own completion is what later callers test for: until it finishes there is
 * nothing on which a second caller could see that the first is already at it.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;

  return () => {
    if (pending) return pending;

    const flight = run().finally(() => {
      if (pending === flight) pending = null;
    });
    pending = flight;
    return flight;
  };
}

/**
 * Collapse overlapping runs of one asynchronous operation into the run in
 * flight plus at most one follow-up.
 *
 * A caller arriving while a run is pending receives the promise of a fresh run
 * that starts once the pending one settles, and every caller arriving during
 * that same window shares it. A caller arriving while the follow-up is itself
 * running queues one more, so the queue never grows past a single trailing
 * run. This is the guard for work that reads mutable state on its first line:
 * a caller who just changed that state cannot be answered by a run that read
 * the old value, and joining the run in flight would answer it with exactly
 * that.
 */
export function trailingFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  let queued: Promise<T> | null = null;

  const begin = (): Promise<T> => {
    const flight = run().finally(() => {
      if (pending === flight) pending = null;
    });
    pending = flight;
    return flight;
  };

  return () => {
    // The queue is read first because a pending run clears itself as it
    // settles, which leaves a gap before the follow-up starts. A caller
    // landing in that gap is a caller of the follow-up, not of a third run.
    if (queued) return queued;
    if (!pending) return begin();

    const follow = pending.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      queued = null;
      return begin();
    });
    queued = follow;
    return follow;
  };
}
