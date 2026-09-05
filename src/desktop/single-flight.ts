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
