import { expect, it } from 'vitest'
import { permissionForRoute, PUBLIC } from '../../lib/auth/permissions-manifest.js'
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

/**
 * A-15 — the memory bill is `entries × businesses`, and the second number was invisible. This
 * reports it so a cap can be chosen from production rather than guessed.
 */
it('reports how many businesses the cache is holding', () => {
  const stats = sheetColumnCacheStats()
  expect(stats.businesses.max).toBe(64)
  expect(stats.businesses.held).toBeGreaterThanOrEqual(0)
  expect(stats.businesses.held).toBeLessThanOrEqual(stats.businesses.max)
  // 🔴 That the READ does not create or reorder a bucket is asserted where it can actually fail —
  // `lib/workspace-cache.vitest.test.ts`. A "read it twice, same number" check here would pass
  // even if the first read created a bucket, because the second read would find the one the first
  // one made. The fixture would pin the dimension the claim is about.
})

/**
 * 15.3 (b) — the route that reports the cache is behind a permission, not on the PUBLIC list that
 * `/admin/health` sits on. The RBAC coverage gate proves a route is MAPPED; it does not prove
 * WHICH permission, and PUBLIC counts as mapped.
 */
it('keeps the sheet cache-stats route behind admin.view, not on the public list', () => {
  const required = permissionForRoute('GET', '/admin/pim/sheet-cache-stats')
  expect(required).not.toBe(PUBLIC)
  expect(required).toBe('admin.view')
  // The positive control: the route next to it on the PUBLIC exact-path list really is public, so
  // a "not PUBLIC" pass here means the manifest was read, not that the lookup quietly failed.
  expect(permissionForRoute('GET', '/admin/health')).toBe(PUBLIC)
})
