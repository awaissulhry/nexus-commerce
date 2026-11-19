/**
 * The one longer timeout of the API unit tests that are slow by nature (B-W2b-30): the guard tests that copy the source
 * folders into a temporary root and start node on a scripts/factory guard (append-only, integration calls, event
 * contract, clustered crons, route manifest, money grains), and the boot of every real routes file (the grain filter,
 * the live stream). Alone they take a few seconds; with several worktrees testing at once they pass vitest's default
 * 5 s. A describe block that holds such tests passes `{ timeout: SLOW_TEST_TIMEOUT_MS }` (a hook that boots the routes
 * takes it as its timeout); every other test keeps the default.
 */
export const SLOW_TEST_TIMEOUT_MS = 60_000
