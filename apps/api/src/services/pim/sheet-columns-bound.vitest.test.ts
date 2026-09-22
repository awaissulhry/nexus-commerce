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
