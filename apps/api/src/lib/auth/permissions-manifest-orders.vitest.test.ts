/**
 * MCP full control 07 O1 — sending the day's corrispettivi (B2C fiscal summary) to the RT is a fiscal act, not an
 * export: it needs `orders.edit`. Before, the `/api/corrispettivi` prefix gave every route, the dispatch included,
 * to `orders.export`. Reading the XML and the preview stay exports.
 *
 * Expected permissions are written from the route's purpose (see permissions-manifest-order.vitest.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { permissionForRoute } from './permissions-manifest.js'

describe('07 O1 — corrispettivi permissions', () => {
  it.each([
    ['POST', '/api/corrispettivi/daily/:date/dispatch', 'orders.edit'],
    ['GET', '/api/corrispettivi/daily/:date.xml', 'orders.export'],
    ['GET', '/api/corrispettivi/daily/:date/preview', 'orders.export'],
  ])('%s %s requires %s', (method, path, permission) => {
    expect(permissionForRoute(method, path)).toBe(permission)
  })
})
