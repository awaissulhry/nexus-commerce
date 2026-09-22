import { expect, it } from 'vitest'
import { sheetColumnCacheStats } from './sheet-columns.service.js'

/**
 * 15.3 — the column-set cache is bounded. The rule lives in `WorkspaceCache`; this asserts it is
 * still WIRED here, because a cache whose constructor loses its argument goes back to unbounded in
 * silence and nothing else in the suite would notice.
 *
 * The key carries `familyIds` and `savedFields`, so an unbounded bucket grows once per family and
 * per saved column selection a user opens, for the life of the process.
 */
it('bounds the sheet column-set cache per business', () => {
  const { max, ttlMs } = sheetColumnCacheStats()
  expect(Number.isFinite(max)).toBe(true)
  expect(max).toBeGreaterThan(0)
  expect(max).toBeLessThanOrEqual(64)
  expect(ttlMs).toBe(5 * 60_000)
})
